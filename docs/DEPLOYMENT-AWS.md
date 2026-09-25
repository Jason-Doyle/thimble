# Deploy to AWS

AWS is a secondary deployment path. The example uses:

- Lambda container image plus AWS Lambda Web Adapter
- Lambda Function URL for the authority and browser assets
- separate private S3 buckets for data and authentication records

The CloudFormation template is `deploy/aws/template.yaml`.

The Lambda authority can be deployed with the application or as a separate
service behind the same public application gateway. See
[In-app and separate authority deployment](AUTHORITY-DEPLOYMENT.md) for the
scaling and operations tradeoffs.

## Build the Lambda image

Build the Lambda-compatible image, which includes the pinned AWS Lambda Web
Adapter:

```powershell
docker build -f Dockerfile.aws -t thimbledb-aws .
```

Build, tag, and push the image to ECR.

## Deploy

Generate secrets in the shell:

```powershell
$env:THIMBLE_MASTER_KEY = node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
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
    EntraTenantId=<tenant-id> `
    EntraAudience=<api-audience> `
    EntraRequiredScope=thimble.access
```

Remove the shell values after deployment.

The template also accepts `OidcProviderId`, `OidcIssuer`, `OidcAudience`,
`OidcJwksUri`, `OidcAllowedTenants`, `OidcRequiredScope`, and
`OidcRequiredRole` for a non-Entra provider.

Generate the recommended Entra delegated scope and application roles with
`npx thimbledb generate-entra-roles --out entra-authorization.json`. For
machine access, use a service principal and required application role rather
than a static global key.

## Template capability

The checked-in CloudFormation template exposes the core provider, OIDC, key
version, collection-layout, and retention settings. It does not currently
expose:

- `THIMBLE_COLLECTION_INDEXES`
- `THIMBLE_COLLECTIONS`
- `THIMBLE_HEAD_TTL_MS`
- `THIMBLE_STUDIO` or `THIMBLE_STUDIO_ORIGIN`
- `THIMBLE_READ_BUNDLES`

The supplied deployment therefore leaves Studio, covering indexes, and read
bundles disabled. Use a reviewed derived template or another Node deployment
configuration when those optional features are required. Setting variables
only in the deployment shell does not pass them into the Lambda function.

The template still passes its legacy `RetiredCollectionLayouts` value into
the Lambda environment. The authority runtime does not perform retired-layout
cleanup. Pass `THIMBLE_RETIRED_COLLECTION_LAYOUTS` to the separate quiescent
retention command when cleanup is required.

For key rotation, deploy `KeyVersion` as the current write version and
`ReadKeyVersions` as the comma-separated historical versions that remain
readable.

## Read path

All browser reads use the authenticated Function URL broker and require a
session and scope grant. Both S3 buckets remain private and are accessible only
to the Lambda role.

## Authority permissions

The Lambda instance role is limited to the configured S3 prefix. It can:

- read objects
- create and conditionally replace objects
- delete revoked auth records and operator-approved maintenance targets
- list only the application prefix

The browser has no S3 write credentials.

The Node authority reads the trusted client source address from the Lambda Web
Adapter's `x-amzn-request-context` header when running inside Lambda. It does
not trust caller-controlled `X-Forwarded-For` values. If the request context is
unavailable, external-subject limits still apply and source-IP limiting is
skipped rather than collapsing all users onto the adapter loopback address.

## Verify

- Function URL serves the application and `/api/config`.
- `/api/config` advertises the optional bounded read-bundle route.
- An eligible cold point read uses one browser request.
- S3 objects are private from the S3 endpoint.
- Brokered private object bodies start with `TDB1`.
- The auth bucket is never browser-readable.
- Lambda role cannot access outside the configured prefix.
- Browser writes go only to the Function URL.

## Public transport endpoint

The Function URL is publicly reachable, but application data routes require a
ThimbleDB session and scope grant created from a validated external identity.
AWS WAF, API Gateway, or another edge control can add cost and abuse protection
without replacing application authorisation.

The auth bucket expires current and noncurrent session and rate-limit objects
after seven days, then removes expired delete markers. Adjust that period if a
deployment uses a longer operational retention window.

## References

- [AWS Lambda Web Adapter](https://github.com/aws/aws-lambda-web-adapter)
- [Lambda container images](https://docs.aws.amazon.com/lambda/latest/dg/images-create.html)
- [Cognito users with per-user S3 prefixes](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_examples_s3_cognito-bucket.html)
