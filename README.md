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
**Letters:** *Letter on letterhead…* in a client's ⋯ menu writes a letter (for a school, an employer, another provider) on the practice letterhead, with a live preview, and saves it as a PDF. The logo and signatures come with the app (copied into release builds from the project folder, never committed); *Letterhead & signatures* replaces them or edits the practice details.

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
