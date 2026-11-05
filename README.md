# Echo

Dictate a session summary, get an audit-ready clinical note, paste it into your EHR.

Echo is a macOS desktop app for outpatient therapists. It is **not** an EHR. It handles the part between "session ended" and "note is in the chart":
structuring, clinical language, medical necessity, treatment-plan linkage and liability-conscious wording. The EHR remains the record.

## The workflow

1. **⌘N** from anywhere (on a client's page it starts their note directly). A note opens with today's date, your usual service code and setting. Session times aren't entered here: you record them in the EHR, which is the record.
2. **⌘R** to dictate (or type). Pause with ⌘R if you want to dictate in bursts, but you don't have to stop.
3. **⌘↵** when you're done. One press stops the mic, finishes the transcript and writes the note in the background. Echo uses the client's treatment plan, rolling clinical context and last three notes, so you never repeat background. Discharge summaries and *Update with AI* plan reviews get every finalized note instead, since they cover the whole course of treatment.
   **You don't have to wait.** The note goes off to be written and Echo takes you back to the client's page. The **Activity** panel at the foot of the sidebar shows what's writing and which finished notes you haven't opened yet. Open the next client (or press ⌘N) and dictate the next session while the last one writes. When a batch is done, the notes are waiting in Activity and on *Queue* (⌘0), which also lists drafts and notes finalized but not yet copied.
   **Live feedback (optional, Settings › Claude).** While you dictate, the side panel lists what the note needs (interventions, client response, goal progress, next steps for a progress note; its own lists for intakes and discharges) and ticks each off as you say it. When everything is covered it reads *Ready to write* and a *Covered* pill appears beside the timer. Safety and mental status aren't listed while their attestation switches are on. If you mention risk, *Risk level* and *Safety plan or actions* are added. Each phrase is transcribed on your Mac as soon as you pause, so the text appears in the dictation field as you talk, and the checks go to Claude Haiku 5.5 (`claude-haiku-5-5`, low effort) every few seconds with the client's name removed. Echo still records the whole dictation while you talk; that recording is transcribed only if live transcription can't start (for example while the speech model is still downloading) or fails partway, and otherwise discarded.
4. Review. The side panel shows an **audit-readiness checklist**, anything the AI wants you to verify, and the goal updates it will apply. **Answer by voice** (or *Follow up* in the toolbar) listens right away. Answer the flagged items, press ⌘↵, and Echo revises the draft rather than rewriting it: your hand edits stay, changed sections are marked, and *Undo* restores the previous draft. The follow-up is appended to the dictation, so a later *Regenerate* still has it.
5. **⌘S** (*Finalize & copy*). The note is on your clipboard. Paste it into the EHR. Per-section copy buttons cover EHRs that use separate fields.

Finalizing also updates the client's treatment-plan goal statuses (you can untick suggestions) and refreshes the clinical context.

| Note | CPT | What Echo produces |
|---|---|---|
| Intake | 90791 | Full diagnostic evaluation, provisional ICD-10 diagnoses with DSM-5-TR rationale, initial SMART treatment plan |
| Progress | 90837 (90834/90832 selectable) | SOAP, DAP, BIRP or narrative, plus a risk section, tied to numbered goals |
| Discharge summary | 90837 or unbilled | Course of treatment, final goal status, aftercare. Moves the client to *Discharged* |

**Existing clients:** choose *Existing client* when adding them, dictate a minute of background and goals, and Echo drafts the treatment plan and context.
**Plan reviews:** *Update with AI* on the plan tab. Dictate what changed ("goal 1 is met, add a goal around…"), or leave it blank and Echo works out the changes from the notes since the last plan review, listing each one with the session that supports it. Every change keeps the previous version in history. *Save PDF* exports a printable copy with a clinician signature line for the chart.
**Letters:** *Letter on letterhead…* in a client's ⋯ menu writes a letter (for a school, an employer, another provider) on the practice letterhead, with a live preview, and saves it as a PDF. The logo and signatures come with the app (copied into release builds from the project folder, never committed); *Letterhead & signatures* replaces them or edits the practice details. *Write with AI* (⌘↵) turns rough ideas into the letter, or tidies a draft's wording and paragraphs, using your writing model. The client's name goes out as a placeholder and is put back when the letter returns; Claude is told to use only facts you gave and to flag any it needs (a start date, say) as items to check. *Undo* restores your text.
**Ask Claude** (⇧⌘A, a tab on each client): a consultation chat with Opus 5.5 or Sonnet 5.5 about that client. A chat starts from the client's diagnoses, treatment plan, clinical context and every finalized note, with the name removed (from what you type too); the scratchpad is never included. Each chat keeps the record exactly as it was when it started, so Claude's reasoning carries from one message to the next; notes finalized later go out with your next message. Claude also sees the Library items the client has been given (title, date, whether done, and a measure's score; never the PDFs, what's written on them, or added files and letters), so it doesn't re-suggest what they have and can track scores; when that list changes, the new one goes with your next message. Each Library item Claude links has an *Assign* button that gives the client their own copy; once they have it, it reads *Assigned* and opens their copy. Chats are saved in the encrypted vault, are not part of the record, and never feed into notes. *Delete all chats* clears a client's chats. The header shows what Claude can see and what the chat has cost so far; starting one reads the whole record once (cached for follow-ups).
**Library** (⇧⌘L): your worksheets, handouts and measures from the `ClinicalResources` folder (ACT, anxiety and its subtypes, depression, measures, safety planning), plus ACBS member resources (metaphors, exercises, ACT process measures, protocols). Everything opens in Echo's viewer, a panel over the right of the window, so a chat stays visible beside it: PDFs in the built-in PDF viewer, ACBS pages as text with a tab per attachment, audio with a player. Word, PowerPoint and Excel files are exported to PDF by Pages, Keynote and Numbers when the catalogue is built, so forms keep their layout; *Open in Word/Keynote* opens the original. Each measure in the ACT Measures Package (and each piece of *Getting Unstuck in ACT*) is its own short PDF, with *Whole document* for the full package. Claude knows the library by title in Ask Claude and links what fits; the composer's book button attaches one to your question.

**Documents** (a tab on each client): the client's own copies of Library worksheets and measures, filled in inside Echo, plus anything else kept for them. *Assign from Library* (or *Assign to client* in the Library viewer) copies the item, with all its tabs, into the client's documents as one PDF. ACBS pages are printed to PDF, and measures and worksheets start under *To complete*. Open one to fill it in: form fields become real inputs, and since almost none of the library PDFs have fields, the markup tools are what fill most of them. *Text*, *Check*, *Cross*, *Circle* (click to circle an answer, drag for a bigger one), *Draw*, *Highlight*, *Erase*, stamps for today's date and the client's name, and *Sign*, which places a signature from *Letterhead & signatures*. Keys: V T C X O D H E, ⌫ deletes, ⌘Z undoes. Each document has one Undo history, shared by the main and presentation windows, that lasts until Echo quits, so leaving a document doesn't lose it. Ink colour and size are remembered and the same in both windows. A Library resource with several tabs (the ACT ADVISOR's measure, rating form, scoring instructions and charts, say) becomes one document with the same tabs, every page of it editable. *All pages* beside *Drag to EHR* chooses which pages go out when it's saved, previewed or dragged, by tab or page, so instructions needn't reach the chart. *Score* on a measure tracks the total over time (e.g. 18 → 14 → 9 on the row). *Add file…* (or dropping PDFs and images on the tab) keeps outside documents such as a signed consent. Letters and plan PDFs can be saved here too (*Save to documents*). To get a document into the EHR, drag the grip on its row (or *Drag to EHR*) into the EHR's upload box, or use *Save as PDF…*. The file is named "Title - Client - date.pdf" so the chart is easy to check.
**Present** opens the document alone in its own window, to share on screen in a telehealth session (share that window, not the screen); it has the same tabs and tools, and opens on the tab you were on. It shows only the document's title and pages, and the tools work there; marks show in the main window as you make them. The window has its own narrow bridge to Echo (`src/preload/present.ts`): it can read and mark up that one document and nothing else, so no other client's name, notes or list is in it at all. It closes when Echo locks.

Safety planning uses current official material: the Columbia C-SSRS screeners (2026), NIMH's ASQ and Brief Suicide Safety Assessment for adult outpatients, and the Stanley-Brown Safety Plan (2021; the authors permit individual use, but changing it or adding it to an EHR needs their written permission).

The catalogue is built by `node scripts/catalog-resources.mjs`, which says at the top what's included; rerun it after adding files (the first run asks to let Terminal control Pages, Keynote and Numbers). ACBS content is a member's copy saved in `ClinicalResources/ACBS`: `scripts/select-acbs.mjs` picks what to keep from a crawl of the site, taken with a signed-in session. Some ACBS pages only describe a resource and link to it (the ACT ADVISOR's *click here to download*); `scripts/follow-acbs-links.mjs` saves those linked files as the resource's attachments: `pages` lists the members-only pages to read with a signed-in session, and `fetch found.json` downloads what they and the pages link to. The folder itself (~650 MB of published material and generated PDFs in `.echo/`) stays out of git. The practice's copy, only the files the catalogue uses, lives in the Google Workspace shared drive at `Shared drives/Resources/Echo Library`; Echo finds it there through Google Drive for desktop on any Mac signed in to the workspace, or you can choose another folder in the Library. After rebuilding the catalogue, copy new files into that folder too.

## What's built in for audits and liability

The AI prompt (`src/shared/prompts.ts`) encodes payer documentation expectations. Deterministic checks (`src/shared/compliance.ts`) back it up:

- **Time integrity.** Start and stop times live in your EHR, not in Echo, and the model is told never to write times or durations into the note. Confirm the CPT code against the actual session length there (90837 ≥ 53 min, 90834 38–52, 90832 16–37).
- **Medical necessity.** Every note ties symptoms and functional impairment to the diagnosis, names the specific interventions and the client's response, and states why treatment continues. For 90837, the model infers the rationale for the extended session from the dictation and clinical context and writes it into the Assessment, so you don't have to state it each time.
- **Treatment-plan linkage.** Progress is reported against numbered goals. Plan review dates (default 90 days, configurable) surface on *Queue*.
- **Fidelity.** The model may turn "we looked at thinking traps" into "cognitive restructuring", but it may not invent interventions, quotes, scores or homework. Gaps become *Please review* items rather than fabricated content.
- **Anti-cloning.** Payers flag notes that read the same every week. Routine language is kept short and session-specific.
- **Telehealth.** Each client has a setting (telehealth from home by default, editable under *Edit client*) that every new note uses: POS 10/02 with modifier 95 and your platform, or POS 11 in office. Telehealth notes state that client location was verified and consent is on file unless your dictation says otherwise.

### The routine-defaults design (please read)

You asked that the AI fill in routine safety content since concerns are rare and you always dictate them when they happen. Echo does this as an **attestation**, not a silent assumption:

- Two switches sit under the dictation box, both **on by default**: *No safety concerns this session* and *Mental status unremarkable except as dictated*. Leaving them on is your attestation, so the note is a true statement you made, not something the AI made up.
- The wording is accurate to what happened ("No risk to self or others was reported or observed"), never "Client denied SI/HI", which would claim you asked.
- A **local keyword scan** (SI, suicidal, self-harm, safety plan, abuse, hospitalization, …) turns the safety default off whenever your dictation touches risk. The note then documents exactly what you said, and Echo flags a missing risk level or safety plan.

## Privacy

- **Transcription happens on your Mac.** Dictation is transcribed by NVIDIA's Parakeet model running on the Apple Neural Engine (through [FluidAudio](https://github.com/FluidInference/FluidAudio)). Audio never leaves the computer, and Echo never saves it. The model (about 450 MB) downloads once from Hugging Face into `~/Library/Application Support/Echo Notes/models/` the first time Echo starts; no client data is involved in that download.
- **Client names are stripped.** Before anything goes to Claude, the client's name is replaced with "Client" in the dictation, context and prior notes. The model sees only "Client" plus pronouns. The prompt also tells it to replace third-party names with roles and to omit unnecessary identifying or intimate details (minimum necessary). Other names you say aloud are in the transcript text that's sent.
- **Minimum necessary history.** Routine notes send only the rolling context and the last three notes. Discharge summaries and AI plan updates send every finalized note for that client (names stripped), because they summarize the whole course of treatment.
- **The scratchpad** tab on every client (⇧⌘P) is never sent to the AI and never copied into notes. It works like HIPAA "psychotherapy notes", kept separate from the record. It's a formatted thinking space: headings, highlights, quotes, checklists whose open items show as a count on the tab, templates (next-session agenda, working hypothesis, 5 Ps, people, your own reactions) and reflective *Spark* prompts. You can dictate into it (⌘R or *Dictate*): the audio is transcribed on your Mac, exactly as note dictation is, and the text lands at your cursor. Neither the audio nor the text is ever sent anywhere. *Hide formatting* (the **T** button) tucks the formatting tools away; typed shortcuts like `# ` and `- ` still work.
- **Encrypted at rest.** All data lives in one AES-256-GCM file, `~/Library/Application Support/Echo Notes/echo.vault`. Its key is protected by your macOS Keychain. Echo keeps 14 days of encrypted daily snapshots in `backups/`. *Export encrypted backup* (File menu or Settings) creates a passphrase-protected file you can restore on any Mac.
- **Documents** are kept as they were added, each PDF in its own file under `documents/` in the same folder, encrypted with the vault's key. What's filled in is stored in the vault and drawn onto the PDF only when it's saved out, so marks stay editable and the original never changes. Exported backups include the files. Opening a document in Preview or dragging it out writes a temporary copy (owner-only permissions) to a private folder that's removed after 15 minutes and when Echo quits. Files no longer used are deleted once they're older than the oldest daily snapshot (14 days).
- **Touch ID lock** (Settings) when the Mac sleeps or locks, and after inactivity.
- **Claude requests** go from the main process only (the UI never sees the API key), straight to `https://api.anthropic.com` with the saved key. Anthropic settings inherited from the environment (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_LOG`, CLI login profiles) are ignored, so requests can't be redirected to another organization or logged. Nothing is logged.

> **BAA check (Anthropic BAA of 2026-05-06 and the HIPAA-Configuration Implementation Guide of 2026-10-05):** Echo uses only features the guide lists as Eligible Services for the API: the **Messages API** (`POST /v1/messages`) with **structured outputs** and **prompt caching**, and the **Models API** (`GET /v1/models`, for *Test connection*). It uses no beta features, no Batch or Files API, and no server tools. Haiku, Sonnet and Opus are all in-scope models. Coverage depends on two things only you can confirm:
> 1. The API key must come from an Anthropic API organization with the **HIPAA configuration enabled**. The guide is explicit that the same features in a standard organization aren't covered, even with a BAA in place. Settings and onboarding say this next to the key field.
> 2. Data retention follows your HIPAA-configured organization's settings (there's no per-request `store` flag). See Anthropic's data retention documentation.
>
> The guide also says the Eligible Services shouldn't be used "to diagnose patients, or for treatment purposes", while allowing charting and coding support when licensed clinicians use it and you've tested it for accuracy. Echo's intake notes propose *provisional* ICD-10 diagnoses for the clinician to confirm; decide whether that fits your reading of the guide.

The writing model and effort are editable in Settings: Haiku 5.5 (`claude-haiku-5-5`, the default, at medium effort), Sonnet 5.5 (`claude-sonnet-5-5`), Opus 5.5 (`claude-opus-5-5`), or any other Claude model ID under *Other…*. If you rewrite the same note twice on one model (*Regenerate*, or *Try again* after the model declined or cut the note off), the note offers the next model up. *Write with Sonnet 5.5* uses it for that note and its follow-ups only; *Use for all notes* changes the setting. Network, key and rate-limit errors don't count toward the offer. Saved settings from the OpenAI version move to Claude and the local speech model automatically, and a saved OpenAI key is cleared so Settings asks for an Anthropic one. *Test connection* checks the key and lists the models it can use.

All three models run Anthropic's safety classifiers. Echo uses no beta features, so it doesn't turn on the automatic refusal fallback that Sonnet and Opus offer. If a model declines a note (rare, but possible with risk-heavy dictation), Echo says so and the dictation stays in the draft to retry or write by hand.

## Running it

```bash
npm install          # also downloads the Electron runtime
npm run dev          # build the speech helper, then run with hot reload
npm run dev:mock     # demo mode: built-in sample output, no Claude calls
npm test             # unit tests (CPT rules, risk scan, prompt privacy, schemas, formatting)
npm run package      # build release/mac-arm64/Echo.app
npm run dist         # build a .dmg
```

Building needs Xcode (Swift 6) for the speech helper in `native/transcriber`, which `dev`, `package` and `dist` build first (`npm run build:transcriber`). Packaging signs the app and the helper with the Developer ID found in your keychain and notarizes when Apple credentials are present in the environment.

Note: `npm run dev` and the packaged app share the "Echo Safe Storage" Keychain item. Running both on one Mac can prompt for Keychain access, so set `ECHO_USER_DATA=/some/test/folder` when developing.

## Code map

```
src/shared/      Pure logic, unit-tested: types, prompts + JSON schemas, CPT/risk/audit checks,
                 clipboard formatting, applying AI output to notes/plans, the note queue
src/main/        Electron main: encrypted vault, Claude client (+ mock), local transcriber, iPhone link, IPC, menus, Touch ID lock
src/preload/     The narrow, typed bridge exposed to the UI as window.echo
src/renderer/    React UI (Queue, Client, Note composer, Plan, Settings)
native/transcriber/  Swift helper that runs Parakeet on the Neural Engine (JSON lines over stdin/stdout)
ios/             Echo for iPhone (SwiftUI): record, transcribe on the phone, send to the Mac
```

## Echo for iPhone

A small companion app in `ios/` for dictating away from your desk. It records, transcribes on the phone and hands the text to Echo on your Mac. It isn't for reviewing notes or pasting into the EHR; that all stays on the Mac.

1. **Pair once.** On the Mac, *Settings › iPhone › Pair iPhone* shows a QR code. Scan it from the iPhone app (first run, or its Settings). The code holds a random 256-bit key. The phone keeps it in its Keychain (this device only) and the Mac keeps it in the vault.
2. **Record.** One big button. Start with the client's name ("This is for Jordan…"). Locking the phone doesn't stop the recording; a phone call pauses it.
3. **Transcribed on the phone** by the same Parakeet model, through FluidAudio (a one-time download of about 450 MB). The audio is deleted as soon as the transcript is saved.
4. **Sent when you're home.** When the phone and the Mac are on the same Wi-Fi with both apps open, the phone finds the Mac over Bonjour and sends the transcripts, encrypted with the pairing key (AES-256-GCM). Nothing goes through the internet or any cloud service. The phone deletes each transcript once the Mac confirms it's saved, and keeps only a receipt (time and length) until the end of the day. iOS doesn't let the app reach the Mac while it's closed, so open it when you get home.
5. **Confirm the client on the Mac.** Recordings appear at the top of *Queue* under *From your iPhone*. Echo suggests the client by fuzzy-matching the opening words against your client list (it copes with misspellings like Caitlin/Kaitlyn, and with names split or joined). You confirm, or pick another client, then *Write note* (or *Open draft*). Nothing is written until you confirm. When Echo matched a misheard name ("Caitlin" for Kaitlyn), it respells it the way you entered it, so name-stripping still removes it before anything goes to Claude. If you pick the client yourself because no name was matched, nothing is respelled, the same as with dictation on the Mac. The note is dated the day it was recorded, not the day it arrived.

Face ID (or the passcode) protects the iPhone app by default, and the app is hidden in the app switcher. Transcripts on the phone use iOS's strongest file protection, and nothing is backed up to iCloud. Code: `src/shared/mobile.ts` (matching), `src/main/link.ts` (receiver and wire format), `ios/EchoMobile/Link/MacLink.swift` (sender).

### Hands-free mode

An optional way to dictate several notes in a row without touching the phone: on a walk with headphones in, or with the phone on the counter. It's off by default. Turn it on in the iPhone app's *Settings › Hands-free* and a Hands-free switch appears under Record. With the switch on, Record starts a hands-free session; with it off, Record and everything behind it work as they always have.

Tap Record, lock the phone, and talk. Every command starts with "Okay", with a short pause before and after it, and a chime or a voice (your choice in Settings) confirms it in your ear. No confirmation means Echo didn't hear it, so say it again.

| Say | What happens |
| --- | --- |
| "Okay, new note" | Saves this note and starts the next |
| "Okay, pause" | Stops recording but keeps listening |
| "Okay, resume" | Carries on with the same note |
| "Okay, discard note" | Throws away this note and starts it over |
| "Okay, undo" | Takes back a discard, or the last new note for about a minute |
| "Okay, status" | Tells you which note you're on |
| "Okay, help" | Reads out the commands |
| "Okay, finish" | Saves everything and stops |

**How it works.** A small streaming speech model (Parakeet EOU, 220 MB, downloaded when hands-free is turned on) listens on the phone. It keeps only the last few words in memory and nothing it decodes is logged or saved; Parakeet still writes the real transcript afterwards, the same as any recording. Audio waits about 6 seconds in memory before it's written, so a command can be cut out before it reaches a file (`NoteCutter`). The command's words never land in a note, unless the listener missed them. On a speaker the mic can hear the phone's own confirmation, and that stays in the note rather than risk cutting words said over it; headphones avoid this. Each note is its own file in `Recording/`, so a crash leaves them to be recovered as usual, at the cost of the last few seconds. Notes become memos when the phone is next unlocked, because memos use file protection that can't be written while it's locked. A discarded note is held until the session ends in case of "undo", then deleted.

**Background Inference.** On iOS 27, using the Neural Engine in the background needs the `com.apple.developer.background-tasks.continued-processing.inference` entitlement (`ios/EchoMobile/Echo.entitlements`). If the Neural Engine fails anyway, the listener moves to the CPU, which iOS always allows; if that fails too, it says so in your ear and keeps recording. Code: `ios/EchoMobile/HandsFree/`.

**Confirmation sounds** are audio files in the app, made ahead of time by `ios/scripts/generate-cues.py`: chimes are synthesised, and voice clips come from ElevenLabs using `ELEVENLABS_API_KEY` in `.env`. That key is only for the script. It must never go in the app, which plays these files offline and makes no network calls for them.

**Building the iPhone app:** `cd ios && xcodegen generate` (`brew install xcodegen`), open `EchoMobile.xcodeproj`, choose your team under *Signing & Capabilities*, and run it on your iPhone. The first time Echo on the Mac listens for the phone, macOS may ask whether to accept incoming connections: choose Allow.

## Sources consulted

- [Medicare LCD L33252 checklist (psychiatric diagnostic evaluation and psychotherapy)](https://med.jax.ufl.edu/compliance/documents/medicare-checklists/Psychiatric-Diagnostic-Evaluation-and-Psychotherapy-Services-LCD-L33252-Checklist_04-01-18.pdf)
- [Yale psychiatric documentation audit standards](https://files-profile.medicine.yale.edu/policy-tech/c00fd3ac-e489-4e33-a836-af77ccf0f501)
- [Brellium: 90837 billing and documentation compliance](https://brellium.com/articles/90837-cpt-code-billing-documentation-compliance-guide)
- [Brellium: CPT 90791 guide](https://brellium.com/resources/articles/cpt-code-90791-the-complete-guide-to-psychiatric-diagnostic-evaluation)
- [OmniMD: 90837 vs 90834](https://omnimd.com/blog/mental-health-billing-90837-vs-90834/)
- Anthropic Business Associate Agreement (2026-05-06) and HIPAA-Configuration Implementation Guide (2026-10-05), in this folder
- [FluidAudio](https://github.com/FluidInference/FluidAudio) (Parakeet on Core ML)

Payer rules vary. Check your MAC's current LCD and your commercial payers' policies, especially plan-review intervals and telehealth modifiers.
