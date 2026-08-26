# Member Download Website

This folder is the complete static website. It runs locally and can later be published directly with GitHub Pages.

## Run locally on Windows

Open PowerShell in this folder and run:

```powershell
npm run dev
```

Then open:

```text
http://localhost:4173
```

No `npm install` command is required. The local server uses Node.js only. The page loads Firebase browser modules from Google's official CDN, so an internet connection is required.

## Current safe state

`config.js` intentionally contains:

```js
downloadReady: false,
appCheckSiteKey: "",
```

The purchase button remains disabled until the member file, Firebase functions, App Check key, and final GitHub Pages URL are configured. Do not change `downloadReady` to `true` early because this is a Live PayPal integration.

## Files

* `index.html` contains the website structure.
* `styles.css` contains the responsive design.
* `app.js` contains browser remembered access, Firebase callable functions, PayPal return handling, and secure downloads.
* `config.js` contains only public browser configuration.
* `serve-local.mjs` runs the local review server.
* `firebase/paypal-download.cjs` contains the private backend functions.
* `replace-download.ps1` replaces the paid file in private Firebase Storage.
* `private-download` contains your local copy of the paid file and is excluded from Git.

## Replace the paid file

The backend always reads this private Firebase Storage object:

```text
member-downloads/current-download.js
```

The fixed object path means the website and functions do not need to be redeployed when the file changes.

After installing Google Cloud CLI and running `gcloud auth login`, replace the file from PowerShell with:

```powershell
.\replace-download.ps1 -File ".\private-download\Luvvy_LastHit_Obfuscated.js"
```

You can pass any updated file path. The script uploads it to the same private object.

## GitHub Pages

The public repository is:

```text
https://github.com/Luvvydev/Member-Download-Website
```

The GitHub Pages address will be:

```text
https://luvvydev.github.io/Member-Download-Website/
```

The paid file is excluded through `.gitignore`. Never remove that exclusion or place the paid file in the public website files.

## Work with Git on Windows

A downloaded ZIP does not contain the repository's `.git` metadata, so `git status` will fail inside an extracted ZIP.

Keep the extracted ZIP as your local package. For Git work, open PowerShell in `Downloads` and run:

```powershell
git clone https://github.com/Luvvydev/Member-Download-Website.git
cd Member-Download-Website
git status
```

Use that cloned folder for future website edits and pushes. Keep updated paid files outside the cloned repository, or inside its ignored `private-download` folder.
