# Deploy to AWS

AWS is a secondary deployment path. The example uses:

- Lambda container image plus AWS Lambda Web Adapter
- Lambda Function URL for the authority and browser assets
- S3 for encrypted objects
- CloudFront Origin Access Control for direct ciphertext reads

The CloudFormation template is `deploy/aws/template.yaml`.

## Build the Lambda image

The standard Dockerfile runs an HTTP server on port 8787. For Lambda, add the
AWS Lambda Web Adapter extension to the final image:

```dockerfile
COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:<pinned-version> \
  /lambda-adapter /opt/extensions/lambda-adapter
```

Pin a reviewed adapter release. Do not use an unpinned `latest` tag in a
release image.

Build, tag, and push the image to ECR.

## Deploy

Generate secrets in the shell:

```powershell
$env:THIMBLE_MASTER_KEY = node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
$env:THIMBLE_PASSWORD_PEPPER = node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Deploy the template:

```powershell
aws cloudformation deploy `
  --stack-name thimbledb `
  --template-file deploy\aws\template.yaml `
  --capabilities CAPABILITY_IAM `
  --parameter-overrides `
    ApplicationName=thimbledb `
    ImageUri=<account>.dkr.ecr.<region>.amazonaws.com/thimbledb:<tag> `
    AllowedOrigin=https://<application-origin> `
    MasterKey=$env:THIMBLE_MASTER_KEY `
    PasswordPepper=$env:THIMBLE_PASSWORD_PEPPER
```

Remove the shell values after deployment.

## Read path

Private local-auth reads use the Function URL broker and require a session and
scope grant. The separate auth bucket is accessible only to the Lambda role.

CloudFront remains available for public scopes through Origin Access Control:

```text
https://<distribution>/content-trie/...
```

The CloudFront distribution is publicly readable in this compatibility
template. Its origin path and bucket policy are restricted to
`<prefix>/scopes/public/*`; it cannot read user, tenant, role, or auth-store
objects.

The template configures S3 CORS for `If-None-Match` and a separate zero-TTL
CloudFront behaviour for `HEAD.json`. Immutable nodes use the normal cache
behaviour, while HEAD revalidation reaches the origin rather than remaining
stale at the edge.

## Authority permissions

The Lambda instance role is limited to the configured S3 prefix. It can:

- read objects
- create and conditionally replace objects
- delete unreachable objects
- list only the application prefix

The browser has no S3 write credentials.

## Verify

- Function URL serves the application and `/api/config`.
- CloudFront returns `ETag` and CORS headers.
- S3 objects are private from the S3 endpoint.
- Brokered private object bodies start with `TDB1`.
- The auth bucket is not a CloudFront origin.
- Lambda role cannot access outside the configured prefix.
- Browser writes go only to the Function URL.

## Known gap

The template uses a public Function URL because application authentication is
outside the POC. Add Cognito, API Gateway authorisation, or the application's
existing identity layer before production.

CloudFront signed cookies or Cognito temporary credentials can protect direct
public-scope reads when required.

## References

- [AWS Lambda Web Adapter](https://github.com/aws/aws-lambda-web-adapter)
- [Lambda container images](https://docs.aws.amazon.com/lambda/latest/dg/images-create.html)
- [CloudFront Origin Access Control](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-s3.html)
- [Cognito users with per-user S3 prefixes](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_examples_s3_cognito-bucket.html)
