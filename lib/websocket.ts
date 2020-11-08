import * as cdk from '@aws-cdk/core'
import * as dynamodb from '@aws-cdk/aws-dynamodb'
import {Table} from '@aws-cdk/aws-dynamodb'
import * as apigatewayv2 from '@aws-cdk/aws-apigatewayv2'
import {CfnApi, CfnAuthorizer} from '@aws-cdk/aws-apigatewayv2'
import * as cognito from "@aws-cdk/aws-cognito"
import * as nodejs from '@aws-cdk/aws-lambda-nodejs'
import {NodejsFunction} from '@aws-cdk/aws-lambda-nodejs'
import * as lambda from '@aws-cdk/aws-lambda'
import * as logs from '@aws-cdk/aws-logs'
import * as iam from '@aws-cdk/aws-iam'
import {PolicyStatement} from '@aws-cdk/aws-iam'
import {Role} from '@aws-cdk/aws-iam'
import {AuthorizationType} from "@aws-cdk/aws-apigateway";

export interface Props {
    prefix: string
    region: string
    account_id: string
}

/**
 * Websocket API composed from L1 constructs since
 * aws has yet to release any L2 constructs.
 * via https://github.com/aws/aws-cdk/issues/2872#issuecomment-711023858
 */
export class WebsocketConstruct extends cdk.Construct {
    private websocket_api: CfnApi;
    private authorizer: CfnAuthorizer;
    constructor(parent: cdk.Construct, id: string, props: Props) {
        super(parent, id)

        // table where websocket connections will be stored
        const websocket_table = new dynamodb.Table(this, 'connection-table', {
            tableName: props?.prefix + 'connection-table',
            partitionKey: {
                name: 'connection_id',
                type: dynamodb.AttributeType.STRING,
            },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        })

        // initialize api
        const name = id + '-api'
        this.websocket_api = new apigatewayv2.CfnApi(this, name, {
            name: 'websockets',
            protocolType: 'WEBSOCKET',
            routeSelectionExpression: '$request.body.action',
        })

        let userPool = new cognito.UserPool(this, 'myuserpool', {
            userPoolName: 'myawesomeapp-userpool',
        });

        const authFn = new nodejs.NodejsFunction(this, 'authorizer-lambda', {
            handler: 'handler',
            functionName: props?.prefix + 'authorizer-message',
            timeout: cdk.Duration.seconds(300),
            entry: './endpoints/authorizer/index.js',
            runtime: lambda.Runtime.NODEJS_12_X,
            logRetention: logs.RetentionDays.FIVE_DAYS,
        })

        // initialize lambda and permissions
        const lambda_policy = new iam.PolicyStatement({
            actions: [
                'dynamodb:GetItem',
                'dynamodb:DeleteItem',
                'dynamodb:PutItem',
                'dynamodb:Scan',
                'dynamodb:Query',
                'dynamodb:UpdateItem',
                'dynamodb:BatchWriteItem',
                'dynamodb:BatchGetItem',
                'dynamodb:DescribeTable',
                'dynamodb:ConditionCheckItem',
            ],
            resources: [websocket_table.tableArn],
        })

        authFn.addToRolePolicy(lambda_policy)

        const connect_lambda = this.makeLambda('connect', './endpoints/onconnect/index.js',
            lambda_policy, props, websocket_table);
        const disconnect_lambda = this.makeLambda('disconnect', './endpoints/ondisconnect/index.js',
            lambda_policy, props, websocket_table);

        const message_lambda_role = new iam.Role(this, 'message-lambda-role', {
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
        })

        message_lambda_role.addToPolicy(lambda_policy)

        message_lambda_role.addManagedPolicy(
            iam.ManagedPolicy.fromAwsManagedPolicyName(
                'service-role/AWSLambdaBasicExecutionRole'
            )
        )

        const message_lambda = new nodejs.NodejsFunction(this, 'message-lambda', {
            handler: 'handler',
            functionName: props?.prefix + 'send-message',
            description: 'Disconnect a user.',
            timeout: cdk.Duration.seconds(300),
            entry: './endpoints/send-message/index.js',
            runtime: lambda.Runtime.NODEJS_12_X,
            logRetention: logs.RetentionDays.FIVE_DAYS,
            role: message_lambda_role,
            initialPolicy: [
                new iam.PolicyStatement({
                    actions: ['execute-api:ManageConnections'],
                    resources: [
                        this.create_resource_str(
                            props.account_id,
                            props.region,
                            this.websocket_api.ref
                        ),
                    ],
                    effect: iam.Effect.ALLOW,
                }),
            ],
            environment: {
                TABLE_NAME: websocket_table.tableName,
            },
        })

        // access role for the socket api to access the socket lambda
        const policy = new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            resources: [
                connect_lambda.functionArn,
                disconnect_lambda.functionArn,
                message_lambda.functionArn,
                authFn.functionArn
            ],
            actions: ['lambda:InvokeFunction'],
        })

        const role = new iam.Role(this, `${name}-iam-role`, {
            assumedBy: new iam.ServicePrincipal('apigateway.amazonaws.com'),
        })
        role.addToPolicy(policy)

        this.authorizer = new apigatewayv2.CfnAuthorizer(this, 'main-auth', {
            apiId: this.websocket_api.ref,
            authorizerType: "REQUEST",
            authorizerUri: `arn:aws:apigateway:${cdk.Aws.REGION}:lambda:path/2015-03-31/functions/${authFn.functionArn}/invocations`,
            identitySource: ["route.request.header.Auth"],
            name: 'main-auth',
            authorizerCredentialsArn: role.roleArn
        })

        // Finishing touches on the API definition
        const deployment = new apigatewayv2.CfnDeployment(
            this,
            `${name}-deployment`,
            { apiId: this.websocket_api.ref,}
        )

        new apigatewayv2.CfnStage(this, `${name}-stage`, {
            apiId: this.websocket_api.ref,
            autoDeploy: true,
            deploymentId: deployment.ref,
            stageName: 'dev',

        })

        const dependencies = new cdk.ConcreteDependable()

        const connect_route = this.makeRoute(props, connect_lambda, role, 'connect', '$connect', true);
        const disconnect_route = this.makeRoute(props, disconnect_lambda, role, 'disconnect', '$disconnect');
        const message_route = this.makeRoute(props, message_lambda, role, 'sendMessage', 'sendmessage');

        dependencies.add(connect_route)
        dependencies.add(disconnect_route)
        dependencies.add(message_route)
        deployment.node.addDependency(dependencies)
    }

    private makeLambda(lambdaName: String, codePath:string, lambda_policy: PolicyStatement, props: Props, websocket_table: Table, handler: string = 'handler') {
        let nodejsFunction = new nodejs.NodejsFunction(
            this,
            `${lambdaName}_lambda`,
            {
                handler: handler,
                functionName: props?.prefix + lambdaName,
                timeout: cdk.Duration.seconds(300),
                entry: codePath,
                runtime: lambda.Runtime.NODEJS_12_X,
                logRetention: logs.RetentionDays.FIVE_DAYS,
                environment: {
                    TABLE_NAME: websocket_table.tableName,
                },
            }
        );
        nodejsFunction.addToRolePolicy(lambda_policy);
        return nodejsFunction;
    }

    private makeRoute(props: Props, lambda: NodejsFunction, role: Role,
                      id: string, routeKey: string, authorize: boolean = false) {
        // websocket api lambda integration
        const connect_integration = new apigatewayv2.CfnIntegration(
            this,
            `${id}-lambda-integration`,
            {
                apiId: this.websocket_api.ref,
                integrationType: 'AWS_PROXY',
                integrationUri: this.create_integration_str(
                    props.region,
                    lambda.functionArn
                ),
                credentialsArn: role.roleArn,

            }
        )

        // Example route definition
        let fullProps = {
            apiId: this.websocket_api.ref,
            routeKey: routeKey,
            target: 'integrations/' + connect_integration.ref,
        };
        if(authorize){
            Object.assign(fullProps, {
                authorizationType: AuthorizationType.CUSTOM,
                authorizerId: this.authorizer.ref
            })
        }
        return new apigatewayv2.CfnRoute(this, `${id}-route`, fullProps);
    }

    private create_integration_str = (region: string, fn_arn: string): string =>
        `arn:aws:apigateway:${region}:lambda:path/2015-03-31/functions/${fn_arn}/invocations`

    private create_resource_str = (
        account_id: string,
        region: string,
        ref: string
    ): string => `arn:aws:execute-api:${region}:${account_id}:${ref}/*`
}