# Firebase and PayPal setup

This repository uses the separate Firebase Functions codebase `member-download`. Deploying this codebase does not replace or delete the ChessDrills functions codebase.

From the repository root, install the function dependencies with:

```powershell
npm install --prefix firebase
```

Use the Firebase CLI through `npx` so a global installation is not required:

```powershell
npx firebase-tools@latest login
npx firebase-tools@latest use chess-ee6b0
```

Use the existing Firebase project `chess-ee6b0`. Do not enable Firebase Authentication and do not deploy replacement Firestore or Storage rules.

## 1. Finish the public website first

Before deploying payment functions, decide the final GitHub repository name and enable GitHub Pages. You need its complete HTTPS address, such as:

```text
https://luvvydev.github.io/Member-Download-Website
```

That exact address becomes `DOWNLOAD_SITE_URL`. It is also used to configure the reCAPTCHA Enterprise domain. The App Check domain contains only `luvvydev.github.io`, without the protocol or repository path.

## 2. Register Firebase App Check

In Firebase Console:

1. Open App Check.
2. Select `Member Download Website`.
3. Choose reCAPTCHA Enterprise.
4. Create a score based Web key in Google Cloud.
5. Add `localhost` for local development and `luvvydev.github.io` for GitHub Pages.
6. Paste the public key ID into Firebase and save.
7. Put the same key ID in `config.js` as `appCheckSiteKey`.

Do not enable App Check enforcement in the console yet. The function source enforces valid App Check tokens on its four browser callable endpoints. The PayPal webhook uses PayPal signature verification instead.

## 3. Isolated functions codebase

The repository is already configured with the separate codebase `member-download` and the Node.js 22 runtime. The source remains in `firebase/paypal-download.cjs` and does not need to be copied into ChessDrills.

## 4. Store the Live PayPal credentials

From the repository root, run:

```powershell
npx firebase-tools@latest functions:secrets:set DOWNLOAD_PAYPAL_CLIENT_ID --project chess-ee6b0
npx firebase-tools@latest functions:secrets:set DOWNLOAD_PAYPAL_CLIENT_SECRET --project chess-ee6b0
```

Paste the Live Client ID into the first prompt and the hidden Live Secret key into the second. Never put the PayPal Secret in this website, `.env.local`, GitHub, or a screenshot.

## 5. Function parameter values

These nonsecret values are already stored in `firebase/.env.chess-ee6b0`:

```text
DOWNLOAD_PAYPAL_ENVIRONMENT=live
DOWNLOAD_SITE_URL=https://luvvydev.github.io/Member-Download-Website
DOWNLOAD_BUCKET=chess-ee6b0.firebasestorage.app
DOWNLOAD_OBJECT_PATH=member-downloads/current-download.js
DOWNLOAD_FILENAME=Luvvy_LastHit_Obfuscated.js
DOWNLOAD_PRODUCT_NAME=Member Download
```

The PayPal webhook ID is added after the first deployment.

## 6. Upload the member file

The included `replace-download.ps1` script uploads the file to this fixed private object:

```text
member-downloads/current-download.js
```

Run this from the website folder after installing Google Cloud CLI and signing in with `gcloud auth login`:

```powershell
gcloud storage cp ".\Luvvy_LastHit_Obfuscated.js" "gs://chess-ee6b0.firebasestorage.app/member-downloads/current-download.js"
```

For later releases, pass the updated file path to the same command. The object path stays unchanged, so replacing the file does not require a website or function deployment.

The browser never reads Storage directly. `downloadGetFile` verifies the browser access key through Firebase Admin and returns a signed URL that expires after five minutes.

## 7. Deploy only the new functions

Deploy only the separate `member-download` codebase:

```powershell
npx firebase-tools@latest deploy --only functions:member-download --project chess-ee6b0
```

The webhook listener URL will be:

```text
https://us-central1-chess-ee6b0.cloudfunctions.net/downloadPaypalWebhook
```

## 8. Add the PayPal webhook

In the Live PayPal app, add the listener URL above and select only:

```text
CUSTOMER.DISPUTE.CREATED
PAYMENT.CAPTURE.REFUNDED
PAYMENT.CAPTURE.REVERSED
```

Copy the Webhook ID returned by PayPal into `firebase/.env.chess-ee6b0` as:

```text
DOWNLOAD_PAYPAL_WEBHOOK_ID=your-webhook-id
```

Then deploy the isolated codebase again:

```powershell
npx firebase-tools@latest deploy --only functions:member-download --project chess-ee6b0
```

## 9. Enable the website

After the file exists and all functions are deployed, change this in `config.js`:

```js
downloadReady: true,
```

Commit and push `config.js`. GitHub Pages publishes the change automatically. Only then should the $20 PayPal button become active.

## 10. Enforcement and real payment check

After the published site successfully calls the four browser functions, enable App Check enforcement for Cloud Functions in Firebase Console. Because Sandbox was skipped, the final checkout check charges a real $20 payment and may incur PayPal fees.
