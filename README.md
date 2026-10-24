# Certifyx — setup guide

Two sides, one backend:
- **Students** open the site, sign in with **roll number + private code** (no Google account), tick off a **checklist** the admin defined, drop a PDF or photo, done. Category, name, folder and Sheet columns are filled in automatically.
- **Admin / faculty** sign in with **Google**, connect **their own Google account once**, and run everything from the console. All Drive and Sheet writes happen under the admin's own Google OAuth client — students never grant Google permissions.

Installable as an app (PWA) on phones and desktops.

## 1. Supabase
1. Create a project. SQL Editor → run `supabase/schema.sql`, then `supabase/seed.sql` (66 sample rows; import your real roster later). The schema is safe to run again.
   Edit the `faculty_emails` insert at the top first: those Google accounts become faculty.
2. Authentication → Providers → **Google** → enable (this is only for the admin's sign-in). URL Configuration → Site URL = your website.

## 2. Your Google OAuth client (the admin's own client ID)
1. Google Cloud Console → new project → **APIs & Services → Library**: enable **Google Drive API** and **Google Sheets API**.
2. **OAuth consent screen**: user type External (or Internal for a Workspace); add scopes `…/auth/drive.file` and `…/auth/spreadsheets`; then **Publish app → In production**.
   ⚠ Leaving it in *Testing* makes the connection die after 7 days. Only you grant access, so the "unverified app" screen is just a warning you click through.
3. **Credentials → Create OAuth client ID → Web application.** Authorised redirect URIs — add both:
   - `https://YOUR-PROJECT.supabase.co/auth/v1/callback` (admin sign-in to the site)
   - `https://YOUR-PROJECT.supabase.co/functions/v1/google-callback` (connecting Drive/Sheets)
4. Use a **dedicated Gmail** for the project (e.g. `certifyx.yourcollege@gmail.com`) so it can be handed over later. About 700 students × 3 PDFs ≈ 1 GB of the free 15 GB.

## 3. Secrets and functions
```
supabase secrets set GOOGLE_CLIENT_ID=… GOOGLE_CLIENT_SECRET=… SITE_URL=https://your-site.example
supabase secrets set TOKEN_ENC_KEY=$(openssl rand -base64 32)     # encrypts the stored Google refresh token — keep a backup of it
supabase secrets set CRON_SECRET=$(openssl rand -hex 24)
supabase functions deploy student-api admin-students google-connect google-callback send-reminders verify-certificate upload-certificate admin-remove sync-drive-sheet --no-verify-jwt
```
All functions authenticate callers themselves, so JWT verification at the gateway is off (`supabase/config.toml` says the same).

## 4. Site
Edit `config.js` (project URL + anon key), deploy the **contents** of this folder (Vercel / Netlify / GitHub Pages; no build step).
Open `https://YOUR-SITE/check.html` — it tests the key, Google provider, tables, functions and your sign-in, and prints a report.

## 5. First run (the Overview shows a "Finish setup" checklist)
1. Sign in with Google → **Settings → Connect Google**. After consent the app **creates the Drive folder and the Sheet** automatically (header row included).
2. **Students → Import** your roster (`ROLL, NAME`).
3. **Requirements → Add requirement** for each certificate type (name, deadline, required?, sections, max size).
4. **Student access → Generate codes** → *Download CSV* or *Print slips* and hand them out privately. Codes are shown **once**; they are stored only as salted hashes.
5. Optional: automatic sync + reminders (needs `pg_cron` and `pg_net`):
```sql
select cron.schedule('certifyx-sync','*/5 * * * *',$$ select net.http_post(url:='https://YOUR-PROJECT.supabase.co/functions/v1/sync-drive-sheet',
  headers:='{"Content-Type":"application/json","x-cron-secret":"YOUR_CRON_SECRET"}'::jsonb) $$);
select cron.schedule('certifyx-reminders','0 7 * * *',$$ select net.http_post(url:='https://YOUR-PROJECT.supabase.co/functions/v1/send-reminders',
  headers:='{"Content-Type":"application/json","x-cron-secret":"YOUR_CRON_SECRET"}'::jsonb) $$);
```

## How it works
- **Student sign-in**: roll number + 10-character code (`XXXXX-XXXXX`, no look-alike letters). 5 wrong attempts lock the account for 15 minutes; admin can reset a code any time (this also signs the student out everywhere). Students never touch the database: every call goes through the `student-api` function with a private session token (14 days, revocable).
- **Upload**: the requirement decides category, file name (`ROLL_Requirement.pdf`), Drive sub-folder (one per requirement, or one folder — your choice in Settings) and Sheet columns (time, roll, name, category, title, link, submission id, requirement, LATE). Photos (JPG/PNG) are converted to PDF in the browser; the server checks the real PDF signature, size, section and a daily limit. Uploading again for the same requirement **replaces** the old copy — the old one is removed only after the new one is safely stored. After the deadline an upload is accepted and marked **LATE**.
- **Completion** means *every required requirement for the student's section is submitted*; Overview, filters and alert groups all use that rule.
- **Sync** (button / cron) reconciles Drive (including sub-folders), the Sheet and the database; repairs missing Sheet rows; never resurrects anything you deleted on purpose.
- **Reminders**: in-app message to students who still owe a required item due within 3 days or overdue (once per 20 h per item).
- **Verification**: each certificate has a public link `…/verify.html?id=…` (copy it from the student's record). It shows "verified" with a masked name and the last 4 characters of the roll number — only for approved students.
- **Faculty console**: Overview (compliance, needs attention, activity), Students (seat map/table, record, approve/reject/notify), Requirements, Student access, Needs review (duplicates/mismatches), Alerts, Export (4 downloads), Audit log, Settings & system check. `Ctrl/⌘ + K` opens a command palette.

## If something does not work
Open `check.html` first, then match the message:
| You see | Fix |
|---|---|
| "This site is not configured yet" | `config.js` still has placeholders → paste URL + anon key, redeploy, hard-refresh. |
| Student: "Invalid roll number or code" | Roll number must exist in the roster and have a code (Student access). Codes ignore case/spaces/dashes. |
| Student: "Too many wrong attempts" | Wait 15 minutes or reset the code on the Student access page. |
| Settings → "Server is missing GOOGLE_CLIENT_ID…" | Step 3 secrets not set (or functions not redeployed after setting them). |
| After Google consent: "Google connection failed … redirect_uri_mismatch" | Add `…/functions/v1/google-callback` to the OAuth client's authorised redirect URIs (step 2.3). |
| "Google did not return a refresh token" | myaccount.google.com → Security → Third-party access → remove Certifyx, connect again. |
| Uploads fail after a week | OAuth consent screen is in *Testing* → publish it ("In production"), then Reconnect Google. |
| Google sign-in (admin): "provider is not enabled" / "access blocked" / "redirect mismatch" | Supabase Providers → Google; consent screen test users; Supabase URL Configuration. |
| Admin sees "not registered as faculty" | Add the email: `insert into faculty_emails values ('you@gmail.com');` and sign in again. |
| Old design showing | Unregister the old service worker (DevTools → Application) and clear site data. |
| 404 / blank, files in a sub-folder | Deploy the **contents** of the folder, preset "Other", no build command. |
Settings → **Run system check** names the failing step (Google token, folder, Sheet, cron, requirements, codes).

## Tests — `sh run-tests.sh`
- `tests/core.test.mjs`, `tests/student.test.mjs` — 37 tests of the server logic against fake Drive/Sheets/database: codes and lockout, sessions, uploads, replace safety, requirements, late flag, folders, reminders, verification, OAuth state/encryption/code exchange/folder+sheet creation, token handling.
- `tests/e2e.py` — 105 browser checks: the real site as student and admin against the same logic.
- `tests/lint_schema.py` — static checks of `schema.sql`.

## What is NOT verified yet
Real Postgres (`schema.sql` is reviewed and statically checked and re-runnable, but never executed; its row-level-security rules are only emulated), real Google APIs and OAuth consent, real Supabase Auth/Edge runtime. Do a staging run with a test Gmail and 2–3 test students before using it for the whole class.

## Not built yet
Faculty roles (owner/faculty/viewer), per-certificate approval with inline PDF preview, "change my code" screen for students (the API exists), forgot-code by email, year rollover/archive, scheduled backups, e-mail alerts on failures, privacy/retention pages, direct-to-Drive resumable uploads for very large files (uploads currently go through the server, 12 MB max).
