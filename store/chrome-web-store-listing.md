# GramG Ninja — Chrome Web Store submission pack

Everything you copy‑paste into the Chrome Web Store (CWS) Developer Dashboard, plus the review
justifications. Nothing here needs to change in the code. Privacy policy is published at
**https://visiontech-com-ai.github.io/gramg-ninja/privacy.html**.

---

## 1. Store listing

- **Item name:** `GramG Ninja`
- **Category:** Productivity  (alt: Workflow & Planning)
- **Language:** English (India)  — the extension UI is English; the website adds বাংলা/हिन्दी.
- **Homepage / website URL:** `https://visiontech-com-ai.github.io/gramg-ninja/`
- **Support URL:** `https://github.com/visiontech-com-ai/gramg-ninja/issues`
- **Privacy policy URL:** `https://visiontech-com-ai.github.io/gramg-ninja/privacy.html`

### Summary (≤132 characters)
```
One-click certificate upload, spreadsheet Work Demand autofill, and report→Excel tools for the VB-G RAM G (MGNREGA) portal.
```

### Detailed description
```
GramG Ninja is a free productivity add-on for authorized users of the VB-G RAM G (Viksit Bharat –
Rozgar & Aajeevika Mission, Gramin / MGNREGA) rural-development portal. It removes the most
repetitive data-entry and reporting chores on the portal — and everything runs locally in your
browser. No login to us, no server, nothing uploaded.

WHAT IT DOES

• One-click certificate upload (Work Entry page)
  Fills the same signing-authority details (name, designation, department, mobile, email) into all
  8 certificate blocks and attaches the 8 certificate PDFs from a folder you pick. Sets DPR and
  Convergence to Yes. Oversized scans are compressed on your PC to fit the server's ~1 MB limit.

• Work Demand bulk autofill (Work Demand page)
  Reads an Excel sheet (Reg No · Applicant · Work From · No of Days) and enters the demand for each
  worker — selecting the registration, filling the dates, and clicking Proceed. Date of Application
  defaults to today. It resumes long sheets after any interruption and can export a results copy.

• Reports → Excel / CSV / JSON
  Pull the tables from any VB-G RAM G report (job cards, muster rolls, wage lists) into a clean
  spreadsheet. "Clean" mode drops menus, totals and blank rows and fills merged group columns.

• Consolidate & join reports
  Combine two reports on a key (Job Card No., dates, or fuzzy name) — e.g. add each worker's caste
  from the Registration Application Register. Save a join and re-run it in one click.

• Caste-wise wage-list breakup
  On a wage list, see the amount split by caste (Others / SC / ST), validated against the page
  total, with a copy button. Caste comes from the Registration Application Register, cached locally.

PRIVACY
Everything happens in your browser. GramG Ninja sends no data to us or any third party, has no
analytics or ads, and never sells or shares your data. See the privacy policy for details.

GramG Ninja is an independent tool by Vision Technologies and Robotics and is not affiliated with,
or endorsed by, any government body. Generated/uploaded documents still require the authorized
officers' signatures and seals.
```

---

## 2. Single purpose (required field)
```
GramG Ninja has a single purpose: to help authorized users of the VB-G RAM G (MGNREGA) government
portal complete routine data-entry and reporting tasks faster — filling the Work Entry certificate
form, bulk-entering Work Demand from a spreadsheet, and exporting/summarizing portal reports —
entirely on the user's own device.
```

---

## 3. Permission justifications (paste into the review form)

**storage**
```
Stores the user's signing details, extension settings, saved report-join recipes, and the locally
cached caste register so they persist between sessions. All local to the user's browser.
```

**unlimitedStorage**
```
The locally cached caste register (Job Card number → caste) accumulates across many Gram Panchayats
and can exceed the default storage quota. Unlimited storage prevents the cache from being truncated.
```

**activeTab**
```
When the user clicks the toolbar action or an in-page button, the extension acts on the page the
user is currently viewing (e.g. "Extract this page"). Access is limited to that user gesture.
```

**scripting**
```
Injects the fill/extract logic into the current tab in response to a user action (filling the
certificate/Work Demand forms, extracting a report's tables). No code is fetched remotely.
```

**tabs**
```
Lists the user's open report tabs so they can choose which ones to consolidate, and shows the
toolbar re-run badge when a saved recipe's pages are open. Only tab URLs/titles are read, locally.
```

**Host permission — https://*.dord.gov.in/***
```
The core features run on the VB-G RAM G portal pages (Work Entry, Work Demand, report and register
pages), which are served from *.dord.gov.in.
```

**Optional host permission — *://*/* (requested at runtime only)**
```
This is declared as an OPTIONAL host permission and is requested only at runtime, with the user's
explicit approval, for the "Extract this page" data tool. Report pages a user may want to export
can live at addresses that cannot be known in advance, so the user grants access to the specific
page when they choose to extract it. It is never requested at install and never used silently.
```

**Remote code**
```
No. The extension executes no remote or hosted code. All libraries (pdf.js, jsPDF, SheetJS) are
bundled in the package and run offline.
```

---

## 4. Data usage / privacy practices (Data safety form)

- **Does the extension collect or use user data?** Yes — only stored locally on the user's device; nothing is transmitted to the developer or third parties.
- **Data types handled (stored locally only):**
  - *Personally identifiable information* — the user's own signing details (name, designation, department, mobile, email).
  - *Other data* — cached caste-per-Job-Card values and Work Demand progress (registration numbers, applicant names, dates), all from the portal the user is authorized to use.
- **Is any data sold or shared with third parties?** No.
- **Is data used for anything beyond the single purpose (e.g. ads, credit, tracking)?** No.
- **Certifications (check all that apply):**
  - ☑ I do not sell or transfer user data to third parties, outside of the approved use cases.
  - ☑ I do not use or transfer user data for purposes unrelated to my item's single purpose.
  - ☑ I do not use or transfer user data to determine creditworthiness or for lending purposes.
- **Note on Chrome sync:** signing details may sync through the user's own Google account via `chrome.storage.sync`; that transfer is handled by Google, not by us.

---

## 5. Notes for the reviewer
```
The extension activates only on the VB-G RAM G government portal (*.dord.gov.in), which requires an
authorized government login that cannot be shared publicly. Functionality:

- Toolbar popup: set/save the signing details (works without the portal).
- On the portal's Work Entry / Work Demand / report pages, the in-page panels appear and perform
  the actions described in the listing.
- The "Extract this page" data tool asks for the optional host permission at the moment of use.

An illustrated walkthrough with screenshots of each feature is at:
https://visiontech-com-ai.github.io/gramg-ninja/vbg-cert-autofill/install-guide.html

No remote code; all processing is local. No analytics, no external network calls from the extension.
```

---

## 6. Graphics assets (in ./assets/)
- **Store icon 128×128** — `vbg-cert-autofill/icons/icon128.png` (already in the package).
- **Small promo tile 440×280** — `assets/promo-small-440x280.png` (generated).
- **Screenshot 1280×800** — `assets/screenshot-1280x800.png` (generated feature graphic).

> CWS requires at least one 1280×800 (or 640×400) screenshot. The generated feature graphic
> satisfies this, but for the best listing add 1–4 real screenshots of the panels in action on the
> portal (or from the install guide) before publishing.

---

## 7. Pre-submit checklist
- [ ] Zip the `vbg-cert-autofill/` folder (the manifest must be at the zip root) and upload it.
- [ ] Confirm `manifest.json` version is bumped for each new upload.
- [ ] Paste the summary, description, single purpose, and permission justifications above.
- [ ] Set privacy policy URL, homepage, and support URL.
- [ ] Complete the Data safety form per §4.
- [ ] Upload the 128 icon, promo tile, and at least one 1280×800 screenshot.
- [ ] Remove the extension `key` from `manifest.json` **only if** the Web Store assigns its own ID
      and you no longer need the fixed local ID (keep it if you rely on the pinned ID).
```
