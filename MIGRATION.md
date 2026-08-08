# Migration to Taipei + SMS + Custom Domain Email

Runbook for consolidating the stack into `ap-east-2` (Taipei), enabling SMS
verification, moving email onto `ti-smarthealth.com`, and clearing the issues
found during the 2026-07 beta test round.

Account `180891490019`. Written 2026-07-24.

## Progress

| Step | State |
| --- | --- |
| A0 SES production access (Seoul) | filed, **pending approval** |
| A1.1 domain DKIM verified | **done** — `VerifiedForSendingStatus: true` |
| A1.2 sending authorization policy | **done** — `CognitoTaipei` on the Seoul identity |
| A1.3 pool custom FROM on COGNITO_DEFAULT | **not possible** — API rejects it, see correction |
| A1.4 SPF | **done** — added alongside Google verification |
| A1.4 DMARC | not started — `p=none` recommended |
| A2 SES DEVELOPER mode | blocked on A0 — **now the only route to a custom sender** |
| B0 SNS production access | filed, **still sandboxed** |
| B1 raise SNS spend limit | **not in effect** — still `$1` |
| B2 Taiwan sender ID | unverifiable via CLI |
| B3 verify tester numbers | **not in effect** — zero numbers registered |
| B4 flip `SMS_VERIFICATION_ENABLED` | blocked on B0–B3 |
| C1 ap-east-2 network foundation | **done** — subnet group + scoped SGs |
| C2 snapshot / copy / restore | **done** — private instance live in Taipei |
| C3 Lambda deployed to Taipei | **done** — needs `DB_PASSWORD` |
| C4 repoint front door | **done** — now **7** integrations, all on Taipei; stage is `production` (`6f0bzv` was a deployment id, not the stage) |
| C5 soak + decommission | **done 2026-08-03** — Sydney fully decommissioned, see below |
| D1 open Function URL | **closed 2026-08-03** — Function URL deleted |
| D3 RDS private | **done** — restored `PubliclyAccessible: false` |
| D3b live 0.0.0.0/0 exposure | **closed** — Sydney SG tightened, verified still working |
| D4 endpoints consolidated | **done** — single front door |
| D6 lint + locale | **done** — 0 lint errors, locale parity clean; web date picker fixed 2026-07-30 |

### Resources created in ap-east-2

| Resource | Identifier |
| --- | --- |
| KMS key | `alias/tish-rds` → `9975235d-ad31-4837-b730-5a2157aa76fe` |
| DB subnet group | `tish-db-subnets` (3 AZs, default VPC `vpc-0d5227c5012ead9ba`) |
| Lambda SG | `sg-04bc9817aedc7ba73` (`tish-lambda-sg`) |
| RDS SG | `sg-06942ffa08d47eb78` (`tish-rds-sg`) — 5432 from Lambda SG only |
| RDS instance | `season1` → `season1.c308e88466sa.ap-east-2.rds.amazonaws.com`, private, 7-day backups |
| Lambda | `operation-strix`, nodejs24.x, **timeout 15s** (was 3s), 128 MB |
| IAM | inline `CloudWatchLogsApEast2` added to `operation-strix-role-8wrlapsc` |

Three more Lambdas joined the region on 2026-08-01, after this table was written
— Phase 5 rather than Track C, listed here so the region's inventory is complete:

| Resource | Identifier |
| --- | --- |
| Lambda | `tish-migrate`, nodejs24.x, 300s, 256 MB — the migration runner; RDS is private, so this is the only way to apply a migration |
| Lambda | `tish-escalate-db`, nodejs24.x, 60s, 256 MB |
| Lambda | `tish-escalate-dispatch`, nodejs24.x, 120s, 256 MB |

Note `operation-strix` is still on **128 MB** — the C5 "Watch" note below
recommended 256 MB and it was never applied. The three functions above were
created at 256 MB.

---

## Why this shape

The user base is Taiwan. Cognito and the API Gateway are already in Taipei; the
Lambda and RDS are in Sydney, so every API call makes a cross-region hop. Moving
the data plane to Taipei removes that hop.

Critically, **Cognito does not move**. User pools can't be migrated between
regions and passwords can't be exported, so keeping the pool in place avoids
re-registering users entirely. RDS keys profiles on the Cognito `sub`
(`cognito_id UUID UNIQUE NOT NULL`, [backend/index.mjs:40](tish-app/backend/index.mjs:40)),
so a pool move would orphan every profile row. Moving RDS and Lambda instead has
no identity implications at all.

### Current vs target

| Component | Now | Target |
| --- | --- | --- |
| Cognito user pool `ap-east-2_Z97Td3kcS` | ap-east-2 | **unchanged** |
| API Gateway `TISCv1` (u91xzojfja) | ap-east-2 | unchanged, repointed |
| Lambda `operation-strix` | ap-southeast-2 | **ap-east-2** |
| RDS `season1` | ap-southeast-2 | **ap-east-2** |
| SNS / SMS | ap-east-2 | unchanged, sandbox exited |
| SES identity | — | **ap-northeast-2 (Seoul)** |

SES is the one unavoidable outlier: it has no endpoint in Taipei, and Taipei's
only permitted SES region is Seoul. Under the custom-FROM approach the Seoul
footprint is one verified domain identity plus one resource policy — set once,
never operationally touched.

### Tracks

A, B and C are independent and run in parallel. A and B both start with a
support request that takes ~24h, so **file those on day 1**.

---

## Track A — Custom domain email

Goal: send from an address on `ti-smarthealth.com` instead of
`no-reply@verificationemail.com`.

> **Correction (2026-07-24).** This track was originally planned in two stages,
> on the basis that a custom FROM address works while staying on
> `COGNITO_DEFAULT` and therefore needs no sandbox exit. That is what the general
> Cognito documentation describes, but **it does not hold for this pool.** The
> API rejects it outright:
>
> ```
> InvalidParameterException: Cannot configure From email address
> for default email configuration
> ```
>
> Retried with a region-specific `SourceArn` instead of the wildcard — same
> error, so it is the approach and not the ARN. Most likely because Taipei is an
> *Alternate Region* pool: with SES unavailable in-region, the default email path
> uses AWS-managed resources that can't be pointed at your identity.
>
> **Consequence: there is no interim step.** Any custom sender requires
> `EmailSendingAccount: DEVELOPER`, which requires the sandbox exit from A0. The
> two stages collapse into one, gated entirely on that approval.
>
> Do **not** set `DEVELOPER` before A0 is approved. SES Seoul is still sandboxed,
> so Cognito would only be able to email individually verified addresses —
> strictly worse than the current state.

### A0. File SES production access for Seoul — do first, ~24h wait

SES console → region **ap-northeast-2** → Account dashboard → Request production
access. Transactional auth codes; describe bounce/complaint handling. Free.

*Not something I can submit for you.*

### A1. Verify the domain and go live on custom FROM

1. Verify `ti-smarthealth.com` in SES `ap-northeast-2` with DKIM. The Route53
   hosted zone `Z0492003C3ORSSH0BIWC` is in the same account, so SES can write
   the CNAME records itself.
2. Attach a sending authorization policy to the identity.

   **Gotcha:** Taipei is an "Alternate Region" pool (SES unavailable in-region),
   so the policy must trust the **regional** principal
   `cognito-idp.ap-east-2.amazonaws.com` — *not* the global
   `email.cognito-idp.amazonaws.com`. Wrong principal fails silently.

   Use a wildcard region in the resource ARN, defensively — the docs note some
   Alternate Region pools split default email across two regions:

   ```
   "Resource": "arn:aws:ses:*:180891490019:identity/ti-smarthealth.com"
   ```

3. ~~Set `COGNITO_DEFAULT` with a custom `From`.~~ **Not possible — see the
   correction above.** Superseded by A2.

4. **DONE** — SPF added to the apex TXT record, alongside the pre-existing
   `google-site-verification` value in the same record set (a second TXT set
   would have broken SPF; a replacement would have broken Google verification):

   ```
   v=spf1 include:_spf.google.com include:amazonses.com ~all
   ```

   DMARC not yet added. `p=none` with an `rua` address is the safe starting
   point — it reports without affecting delivery. SES already passes DMARC via
   DKIM alignment, so this is monitoring rather than a fix.

The prepared `update-user-pool` payload is still useful for A2 — it reconstructs
every parameter from a live `describe-user-pool`, so the reset footgun is
handled. Only `EmailConfiguration` needs changing to `DEVELOPER`.

### A2. Switch to your own SES (after A0 approves)

Lifts the **50 emails/day per AWS account** ceiling, which is *not adjustable* —
it doesn't appear in Service Quotas because you can't request more. It also
covers password resets and MFA, and resets at 0900 UTC (5pm Taipei), so burning
it in the Taiwan morning locks you out until late afternoon.

1. Set `EmailSendingAccount: DEVELOPER` with `SourceArn` + `From`. Cognito
   creates a service-linked role — the calling session needs
   `iam:CreateServiceLinkedRole`.
2. Create an SES configuration set with CloudWatch/SNS event destinations for
   bounces and complaints.

**This is where deliverability becomes yours.** SES suspends sending above ~5%
bounce or ~0.1% complaint. Transactional codes to self-entered addresses are
well-behaved traffic, but it needs to be *visible*, not discovered.

Worth knowing: on `COGNITO_DEFAULT`, hard-bounced addresses go to an AWS-managed
suppression list you **cannot clear** — potentially permanently locking a user
out over one typo or a full mailbox. A2 gives you control of that list. For a
health app that's arguably a better reason to switch than the volume.

---

## Track B — SMS verification

### B0. File SNS production access for ap-east-2 — do first, ~24h wait

Sandbox is currently ON (`IsInSandbox: true`) with **zero** verified numbers, so
SMS reaches nobody today.

*Not something I can submit for you.*

### B1. Raise the spend limit

`MonthlySpendLimit` in ap-east-2 is **$1/month** — the default. SMS stops dead
when it's hit, without an obvious error. Raise it before launch; note that
raising it above the account maximum is itself a support request.

### B2. Taiwan sender ID registration

Separate from the sandbox exit and separate again from region. Start early;
country registration is usually the long pole.

### B3. Interim: verify beta testers' numbers

While sandboxed, add each tester's number as a verified sandbox destination.
Fine for a handful of people; doesn't scale, which is why B0 matters.

### B4. Flip the app flag

Set `SMS_VERIFICATION_ENABLED = true` in
[constants/config.ts](tish-app/constants/config.ts). The Text/Email selector then
appears on the signup form, defaulting to SMS, and the mechanism is already
built: including `phone_number` in `signUp()` routes to SMS, omitting it forces
email. No other code change needed.

**SMS preference is confirmed on this pool.** A beta tester received email only
from the *resend* action and nothing from the initial signup — which is exactly
the signature of Cognito routing the signup code to SMS (phone_number present and
auto-verified) and SNS dropping it into the sandbox. So the include/omit
`phone_number` mechanism does control the medium here, as designed.

Still worth watching the `[signup] code delivery ->` log line after flipping, to
confirm it reads `SMS` with a real destination rather than falling back.

---

## Track C — Move the data plane to Taipei

Nothing here touches identity, so it's fully reversible until cutover.

### C1. Prerequisites in ap-east-2

- **Republish the pg layer.** Lambda layers are region-scoped;
  `arn:aws:lambda:ap-southeast-2:...:layer:pg-layer:1` cannot be referenced from
  ap-east-2. (Alternative: bundle `pg` into the deployment zip and drop the layer
  — `tish-app/backend/node_modules/pg` is already vendored.)
- **VPC + subnets + security group**, if keeping the Lambda VPC-attached.
- **A KMS key** for the restored database.

### C2. Snapshot and copy — mind the encryption

`season1` is encrypted with a KMS key
(`.../key/0ff4660b-f1b8-4c78-938c-cce231772e61`) that is regional. A cross-region
copy must re-encrypt with a destination-region key, or it fails.

> **Correction (2026-08-03).** That key was described here as *customer-managed*
> and it is not. `describe-key` reports `KeyManager: AWS` under the alias
> `alias/aws/rds` — the default AWS-managed key RDS uses when no other is named.
> The re-encryption requirement above is unaffected and was right for the wrong
> reason: an AWS-managed key cannot be used cross-region either.
>
> What the mistake does change is teardown. **An AWS-managed key cannot be
> deleted** — `ScheduleKeyDeletion` fails with `AccessDeniedException` even as
> root, because the key policy grants the account only `Describe*/Get*/List*/
> RevokeGrant`. This is not a permissions problem to work around; AWS owns the
> key's lifecycle. It also costs nothing, and with no encrypted resource left in
> the region it is inert. The C5 teardown left it in place because there is no
> other option.

```bash
aws rds create-db-snapshot --region ap-southeast-2 --db-instance-identifier season1 --db-snapshot-identifier season1-premigration
```

```bash
aws rds copy-db-snapshot --region ap-east-2 --source-region ap-southeast-2 --source-db-snapshot-identifier arn:aws:rds:ap-southeast-2:180891490019:snapshot:season1-premigration --target-db-snapshot-identifier season1-taipei --kms-key-id <AP_EAST_2_KMS_KEY_ARN>
```

Then restore into ap-east-2 as `db.t4g.micro`, postgres 18.3, 20GB — all
confirmed available there.

**Restore it private** (`--no-publicly-accessible`), per D3. The Lambda is
already VPC-attached, so it reaches the database over private networking with no
code change; only outside admin access is affected, and that's deferred
deliberately. Doing it at restore time avoids a second modify-and-reboot later.

While here, set `--backup-retention-period` above the current 1 day.

This snapshot doubles as the **rollback anchor** for the whole migration.

### C3. Redeploy the Lambda

Same config: `nodejs24.x`, `index.handler`, x86_64. Recreate the four env vars
(`DB_USER`, `DB_NAME`, `DB_HOST`, `DB_PASSWORD`) pointing at the new endpoint —
though see D2, this is the moment to move them to Secrets Manager instead.

**Raise the timeout.** It is currently **3 seconds** on a VPC-attached,
DB-connecting function. Cold start + ENI attach + `pg` connect inside 3s is
marginal and is a plausible cause of intermittent failures testers may have hit
without reporting clearly. 10–15s is more realistic.

### C4. Repoint the front door

- API Gateway `TISCv1` → integrate with the ap-east-2 Lambda. Its
  `CognitoAuthorizer` already points at the Taipei pool, so it needs no change.
- Recreate the Function URL in ap-east-2 — **or better, retire it entirely**, see
  D1.
- Update [utils/api.tsx:5](tish-app/utils/api.tsx:5) and the hardcoded
  `BASE_URL` at [signup.tsx:34](tish-app/app/signup.tsx:34).

### C5. Cutover and soak

**Cutover completed 2026-07-25.** Data was verified identical across regions
before switching — every table compared by row count through each region's own
Lambda, all matching:

```
genders 4  conditions 4  medication-library 3  test-config 3
users 2  appointments 1  medication_reminders 0  test_results 0
user_relationships 1  appointment_statuses 4
```

Post-cutover checks: `/check-availability`, `/genders`, `/conditions` all 200
through API Gateway; `/me` still 401 for anonymous, so the Cognito authorizer is
intact; CloudWatch logs landing in the ap-east-2 log group.

#### Known split during the build window

The TestFlight build currently on testers' devices still calls the **Sydney
Lambda Function URL** for `/check-availability`, while everything else now goes
to Taipei. So an old-build signup checks availability against the stale Sydney
database.

Impact is limited: Cognito is the real uniqueness guard (email and phone are
alias attributes), so a genuine duplicate is still rejected at `signUp` — the
user just gets a worse error message instead of inline feedback. Closes when the
next build ships, since the app now uses the API Gateway route.

#### Decommissioned 2026-08-03

**Sydney is gone. There is no longer a rollback path to it** — see the Rollback
section, which this supersedes.

The soak ended with hard evidence rather than an elapsed timer: CloudWatch showed
the Sydney Lambda's **last invocation was 2026-07-24**, the day *before* cutover,
and **zero** in the nine days since. So the open question in D1 — whether testers
on build 7 were still calling the Function URL — was answered empirically before
anything was deleted. Nobody was.

Verified before deleting: all **7** API Gateway integrations resolved to
ap-east-2 (the table above says 5; it had grown), and no ENIs remained attached
to the Sydney security groups.

Deleted, in this order:

1. Lambda Function URL (`AuthType: NONE` — the D1b user-enumeration endpoint)
2. Lambda `operation-strix`
3. RDS `season1` — `--skip-final-snapshot --delete-automated-backups`
4. Manual snapshot `season1-premigration` — **the rollback anchor, deliberately
   destroyed on the owner's instruction.** Taipei's own 7-day automated backups
   are now the only recovery point; the 2026-07-24 pre-cutover state is
   unrecoverable.
5. Layer `pg-layer:1`
6. Security groups `rds-ec2-1` and `ec2-rds-1`

Post-check: Sydney lists zero RDS instances, zero snapshots, zero Lambda
functions. Taipei `/genders`, `/conditions` and `/check-availability` all 200 and
`/me` still 401, so the Cognito authorizer is intact.

**Two gotchas worth keeping.** The two security groups referenced *each other*
(RDS ingress ← EC2 SG, EC2 egress → RDS SG), so both `delete-security-group`
calls failed with `DependencyViolation` until the pair of cross-referencing rules
was revoked first. And the KMS key could not be deleted at all — see the
correction in C2.

#### Left in Sydney deliberately

Neither is a migration artifact; both predate this stack and were left alone:

- Layer `amplifyDataAmplifyCodegenAssets…AwsCliLayerE322F905`
- Security groups `rds-rdsproxy-1`, `lambda-rdsproxy-1`, `rdsproxy-lambda-1`,
  `launch-wizard-1`, `launch-wizard-2` — from an RDS Proxy setup and the EC2
  launch wizard, unrelated to `season1`

#### Watch

`Max Memory Used: 86 MB` of 128 MB — 67% at idle load. Not urgent, but the
headroom is thinner than it looks for a Node runtime holding a `pg` pool. Worth
raising to 256 MB if cold starts or OOMs appear; it also buys proportionally
more CPU, which shortens the VPC cold start.

---

## Track D — Issues uncovered

### Already fixed and shipped

Date picker two-tap (`keyboardShouldPersistTaps`), iOS wheels closing on first
spin, phone country-code affix, the confirm-screen lockout, missing `checkUser()`
before `/(tabs)`, and `codeDeliveryDetails` wiring.

**Root cause of the "never got the email" report is now confirmed.** A tester
received email only from the *resend* action, never from initial signup. That is
the signature of Cognito routing the signup code to SMS — `phone_number` was
always in the `signUp()` payload and is auto-verified on this pool — with SNS
silently dropping it in the sandbox. It was not a spam-folder problem; no email
was ever sent for the initial code.

The shipped change omits `phone_number` while `SMS_VERIFICATION_ENABLED` is
false, forcing the email route, so signup codes should now arrive first time.
**Confirm this with the next tester before treating report #5 as closed.**

### D0. GitHub OIDC deploy pipeline does not exist

`.github/workflows/deploy-backend.yml` assumes an IAM role via GitHub OIDC, but
the account has **no OIDC provider and no role trusting
`token.actions.githubusercontent.com`**. The one-time setup in
`tish-app/backend/DEPLOY.md` was never completed, so backend deploys have been
manual and that workflow fails at the credentials step.

Not urgent — it also means CI can't overwrite the new Taipei function. But when
you do set it up, note the region moved:

- `AWS_REGION` repo variable → `ap-east-2`
- the deploy role's permissions policy pins **region-specific** function ARNs;
  it must list `arn:aws:lambda:ap-east-2:180891490019:function:operation-strix`

### D1. Public unauthenticated Function URL — resolved in app, deletion deferred

**Update.** API Gateway already exposed `/check-availability` with
`authorizationType: NONE` — verified returning `200 {"exists":false}`. The
Function URL was never necessary; the app now calls the API Gateway route via
`apiRequest` like everything else.

**Do not delete the Function URL yet.** The endpoint consolidation ships in
**build 8** (submitted to TestFlight 2026-07-25, commit `a6fd0c1`), but testers
on build 7 or earlier still call the Function URL for `/check-availability`.
Delete it only once testers have updated to build 8+.

### D1b. Original finding (for context)

`https://zagxjje3mvzinf23amf46czfoy0vwctw.lambda-url.ap-southeast-2.on.aws/` has
**`AuthType: NONE`**. [signup.tsx:159](tish-app/app/signup.tsx:159) calls
`/check-availability?email=…&phone_number=…` on it, which answers whether a given
email or phone is registered.

That is an unauthenticated, unthrottled **user-enumeration endpoint on a health
app** — anyone can test whether a specific person has an account. Worth treating
as a privacy issue, not just a hygiene one.

Options, roughly in order of preference: move the route behind API Gateway with
throttling and a WAF rate rule; or keep it public but rate-limit per IP and
return a uniform response shape. Do this as part of C4 rather than recreating the
open URL in Taipei.

### D2. Database password in plaintext Lambda env vars

`DB_PASSWORD` sits in the function configuration, readable by anyone with
`lambda:GetFunctionConfiguration`. Move to Secrets Manager (or SSM Parameter
Store SecureString) during C3 — it's the natural moment, since the values are
being rewritten anyway.

### D3. RDS is publicly accessible — decided: make it private

`PubliclyAccessible: true` while the Lambda is *also* VPC-attached, so today you
pay the VPC cold-start penalty **and** expose the database to the internet.

**Decision (2026-07-24): restore private.** Handled in C2 rather than as a
follow-up — the restore is the free moment to do it, since flipping an existing
instance means another modify-and-reboot cycle.

Admin access from Australia is knowingly deferred. Once it's needed, the options
are roughly: SSM Session Manager port-forward through a small bastion (no inbound
ports, IAM-controlled, cheapest to run intermittently); a VPN; or temporarily
re-enabling public access behind a locked-down security group. First is
recommended when you get to it.

Also raise `BackupRetentionPeriod` — currently **1 day**.

### D4. Two front doors

[utils/api.tsx:5](tish-app/utils/api.tsx:5) uses the Taipei API Gateway;
[signup.tsx:34](tish-app/app/signup.tsx:34) hardcodes the Sydney Function URL and
calls it with raw `fetch` instead of `apiRequest`. Consolidate to one base URL in
config during C4.

### D5. Root account access

CLI and console are authenticating as `arn:aws:iam::180891490019:root`. Create an
IAM user or Identity Center role for day-to-day work before running the
migration — a lot of the steps above are destructive if mis-typed.

### D6. Smaller items

*Re-verified 2026-07-30. Three of the four entries below were stale — recorded
here rather than deleted, so the same items don't get re-investigated.*

- ~~**Web date picker** renders `null` — birth date is unchangeable in a web
  build.~~ **Fixed 2026-07-30.** `components/platform-date-picker.tsx` now has a
  web branch using the browser's native `<input type="date|time">` inside the
  same modal shell as iOS, following the pattern already used in `results.tsx`.
  Both directions format in local time: `toISOString()` showed the previous day
  for anyone east of UTC before their offset, and `new Date('2026-07-30')`
  parses as UTC midnight. The same off-by-one was fixed in `results-form.tsx`
  and in signup's `birth_date` (PLAN.md 1.8).
- ~~**Pre-existing lint errors**: 5 × `react/no-children-prop`~~ — **stale, no
  such code exists.** There is no `children={undefined}` anywhere in the repo,
  and `npx eslint .` reports **0 errors** (41 warnings, all pre-existing
  unused-vars and exhaustive-deps). Nothing to fix.
- ~~**Locale gap**: `medications.frequencyEvery_one` missing from
  `zh-Hant.json`~~ — **stale, already resolved.** Both `frequencyEvery_one` and
  `frequencyEvery_other` are present in both files, and
  `npm run validate-translations` passes.
- `key.p8` is correctly gitignored and untracked — verified, no action.

**One real gap remains, and it is worth fixing before Phases 3–5 of PLAN.md add
more strings.** `.github/workflows/translations.yml` triggers only on
`paths: tish-app/locales/**`, and the validator compares en against zh-Hant.
So adding a `t('some.new.key')` in code and forgetting *both* locale files
touches no locale path, runs no check, and ships the raw key as visible UI text.
Parity is enforced; coverage is not.

Partially mitigated by something the plan didn't note: **`t()` is typed against
the generated key union**, so a key missing from *both* locale files is already a
TypeScript error at the call site (this is what `npx tsc --noEmit` catches).
The hole that remains is a key present in `en.json` but absent from `zh-Hant.json`
— which parity *does* catch, but only when the workflow actually runs. Widening
the trigger to include `tish-app/**` would close it; note that this workflow
also publishes an EAS update on success, so changing its trigger changes what
gets deployed and when. Deliberately left alone.

---

## Ordering

**Day 1:** D5 (IAM user), A0 + B0 (both support requests), C2 snapshot.
**Then, in parallel:** A1 (email live), B1/B2, C1→C5 (migration).
**On approval:** A2 (SES developer mode), B3/B4 (SMS on).
**Alongside C4:** D1, D2, D4.

## Rollback

> **No longer available as of 2026-08-03.** C5 decommissioned Sydney and, on the
> owner's instruction, deleted `season1-premigration` with it. What follows is
> kept as the record of what the plan was during the migration; it does not
> describe anything you can still do.

The `season1-premigration` snapshot is the anchor. Until C5 completes, the Sydney
stack is untouched and reverting means pointing `utils/api.tsx` and the API
Gateway integration back. Cognito never moves, so no identity state is ever at
risk.

**Recovery today** is Taipei's own 7-day automated RDS backups and nothing else.
Cognito is still untouched by all of this, so identity was never at risk either
way — the exposure is the medication data, and it is now one region deep.

## What I can and can't do

I can write the CLI commands, build the `update-user-pool` call safely from your
current config, and make all the app-side changes.

I can't submit the SES/SNS production-access requests, and I won't handle
credentials or run resource-creating commands without your explicit go-ahead on
each.
