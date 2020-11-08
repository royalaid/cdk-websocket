# What is this?
This is a basic project that glues together websockets via
API Gateway and CDK since at the time of creation no constructs
exist inside CDK itself. It probably doesn't follow best practices
but rather is an exploration by myself. You probably want to double check 
what is going on inside most of this project if you are going to incorporate
into something larger!

## Useful commands

 * `npm run build`   compile typescript to js
 * `npm run watch`   watch for changes and compile
 * `npm run test`    perform the jest unit tests
 * `cdk deploy`      deploy this stack to your default AWS account/region
 * `cdk diff`        compare deployed stack with current state
 * `cdk synth`       emits the synthesized CloudFormation template
