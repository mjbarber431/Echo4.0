import type { LiveEvent } from './coach'
import type { LegacyClientSummary, LegacyImportReport } from './legacy'
import type { Letter, Letterhead, Signer } from './letter'
import type { ClientDocument } from './documents'
import type { ChatEvent, ChatSummary, ChatThread } from './chat'
import type { Ehr, EhrLayout } from './ehr'

// Data model shared by the main process and the renderer.
// IDs are UUIDs and every record carries timestamps so a future iOS companion
// app can sync notes into this store without migrations.

export type NoteType = 'intake' | 'progress' | 'termination'
export type NoteFormat = 'SOAP' | 'DAP' | 'BIRP' | 'Narrative'
export type SessionSetting = 'office' | 'telehealth-home' | 'telehealth-other'
export type GoalStatus = 'not_started' | 'in_progress' | 'partially_met' | 'met' | 'discontinued'
export type ReasoningEffort = 'default' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface Diagnosis {
  code: string
  description: string
}

export interface Objective {
  id: string
  text: string
  status: GoalStatus
}

export interface Goal {
  id: string
  problem: string
  goal: string
  objectives: Objective[]
  interventions: string
  status: GoalStatus
  /** Most recent progress summary, refreshed when notes are finalized. */
  progress: string
  targetDate: string | null
  createdAt: string
  updatedAt: string
}

export interface TreatmentPlan {
  goals: Goal[]
  frequency: string
  modalities: string
  dischargeCriteria: string
  reviewDate: string | null
  lastReviewed: string | null
  updatedAt: string
}

export interface PlanSnapshot {
  savedAt: string
  reason: string
  plan: TreatmentPlan
}

export interface Client {
  id: string
  /** Display name. Shown only in this app; never sent to the AI. */
  name: string
  pronouns: string
  /** Where sessions with this client happen. Copied onto each note when it's started. */
  setting: SessionSetting
  diagnoses: Diagnosis[]
  status: 'active' | 'discharged'
  /** Rolling clinical summary the AI maintains for continuity. Editable. */
  context: string
  /** CONTEXT_VERSION of the rules the context was last written under. Missing on imported and older clients. */
  contextVersion?: number
  /** Private clinician notes, in the scratchpad's Markdown dialect (scratch.ts). Not part of the record and never sent to the AI. */
  scratchpad: string
  plan: TreatmentPlan | null
  planHistory: PlanSnapshot[]
  /** The EHR (Ehr.id from Settings) this client's notes go into, so charting can take the clinician straight there. */
  ehrId?: string
  createdAt: string
  updatedAt: string
}

export interface SessionInfo {
  date: string // YYYY-MM-DD
  cpt: string
  setting: SessionSetting
  participants: string
}

export interface Attestations {
  /** Clinician attests no safety concerns arose this session (used only if dictation is silent on risk). */
  noSafetyConcerns: boolean
  /** Clinician attests mental status was unremarkable except as dictated. */
  mseUnremarkable: boolean
}

export interface NoteSection {
  heading: string
  body: string
}

export interface GoalUpdate {
  goalId: string
  status: GoalStatus
  progress: string
  accepted: boolean
}

export interface NewGoalSuggestion {
  problem: string
  goal: string
  objectives: string[]
  interventions: string
  accepted: boolean
}

export interface AiSuggestions {
  goalUpdates: GoalUpdate[]
  newGoals: NewGoalSuggestion[]
  planMeta: { frequency: string; modalities: string; dischargeCriteria: string } | null
  diagnoses: Diagnosis[]
  contextUpdate: string
  applyDiagnoses: boolean
}

export interface Note {
  id: string
  clientId: string
  type: NoteType
  format: NoteFormat
  status: 'draft' | 'final'
  session: SessionInfo
  attest: Attestations
  dictation: string
  sections: NoteSection[]
  reviewItems: string[]
  suggestions: AiSuggestions | null
  generatedAt: string | null
  finalizedAt: string | null
  copiedAt: string | null
  source: 'desktop' | 'mobile'
  createdAt: string
  updatedAt: string
}

export interface Settings {
  clinicianName: string
  credentials: string
  noteFormat: NoteFormat
  sessionMinutes: number
  telehealthPlatform: string
  planReviewDays: number
  includeHeader: boolean
  includeSignature: boolean
  headingStyle: 'caps' | 'title'
  customInstructions: string
  /** Claude model that writes notes, plans and context. */
  textModel: string
  /** Claude model for new Ask Claude chats (CHAT_MODELS). */
  chatModel: string
  /** Local speech model (TRANSCRIBE_MODELS). */
  transcribeModel: string
  /** The clinician's own terms for the transcriber to listen for, one per line (shared/vocabulary.ts). */
  customVocabulary?: string
  reasoningEffort: ReasoningEffort
  /** Transcribe dictation live, straight into the text, and show what the note still needs while you talk. */
  liveCoverage: boolean
  lockEnabled: boolean
  lockMinutes: number
  onboarded: boolean
  /** The ClinicalResources folder on this Mac. Empty until chosen; in development it defaults to the project's copy. */
  resourcesFolder?: string
  /** Experimental: write notes and amendments with LOCAL_MODEL on this Mac instead of Claude. */
  localModel?: boolean
  /** Experimental: let the local model think before it writes. Slower. */
  localThinking?: boolean
  /** The EHRs Echo opens in Chrome when it's time to chart. */
  ehrs?: Ehr[]
  /** How Echo arranges its window and the EHRs' when it opens them. */
  ehrLayout?: EhrLayout
  /** Open the EHRs when charting starts. */
  ehrOpenOnChart?: boolean
}

/** Settings as the renderer sees them: the API key never leaves the main process. */
export interface PublicSettings extends Settings {
  hasApiKey: boolean
  mockAI: boolean
}

/** A new version of Echo being fetched in the background. */
export interface UpdateStatus {
  state: 'idle' | 'downloading' | 'ready'
  version: string
  /** Download progress, 0–1. */
  progress: number
}

/** The local speech model, as the main process reports it. */
export interface TranscriberStatus {
  state: 'idle' | 'loading' | 'downloading' | 'ready' | 'error'
  model: string
  /** Download progress, 0–1. */
  progress: number
  message: string
  /** The vocabulary checker that corrects clinical terms after transcription. */
  vocabulary: { state: 'off' | 'loading' | 'downloading' | 'ready' | 'error'; count: number; message: string }
}

/** Speech models the local transcriber can run. English v2 is the default: it handled clinical terms best in testing. */
export const TRANSCRIBE_MODELS: { id: string; label: string }[] = [
  { id: 'parakeet-tdt-0.6b-v2', label: 'Parakeet v2 (English)' },
  { id: 'parakeet-tdt-0.6b-v3', label: 'Parakeet v3 (25 European languages)' }
]

/**
 * Claude models offered for writing, least to most capable. Haiku is the default; the
 * others cost more per note and are slower, but reason better over long or ambiguous dictation.
 */
export const WRITING_MODELS: { id: string; label: string; hint: string }[] = [
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5', hint: 'Fastest and cheapest' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', hint: 'More careful, about 20× Haiku’s cost' },
  { id: 'claude-opus-5-5', label: 'Opus 5.5', hint: 'Most careful, about 40× Haiku’s cost' }
]

/** Experimental local writing model, run through mlx-lm (see src/main/local.ts). */
export const LOCAL_MODEL = { repo: 'mlx-community/Qwen3.5-9B-4bit', label: 'Qwen3.5 9B (4-bit, local)' }

export function modelLabel(id: string): string {
  return WRITING_MODELS.find((m) => m.id === id)?.label ?? id
}

export interface AppState {
  settings: PublicSettings
  clients: Client[]
  notes: Note[]
  /** Recordings from the iPhone that haven't been given to a client yet. */
  inbox: MobileMemo[]
  documents: ClientDocument[]
}

/** A document changed in another window (the presentation window, or the main one). */
export type DocumentEvent = { doc: ClientDocument } | { deleted: string } | { presenting: string[] } | { history: DocHistory }

/** How many steps Undo and Redo can take for a document. */
export interface DocHistory {
  id: string
  undo: number
  redo: number
}

/** The presentation window's whole view of Echo: the one document it shows, and nothing else. */
export interface PresentApi {
  /** The document, the tab to open on, and the client's name for its stamp (never shown in the window's title). */
  load(): Promise<{ doc: ClientDocument; bytes: Uint8Array; tab?: number; clientName: string }>
  /** Saves marks, fields and layout. Nothing else about the document can change from here. `undoable` adds a step to Undo. */
  save(doc: ClientDocument, undoable?: boolean): Promise<void>
  history(): Promise<DocHistory>
  undo(): Promise<void>
  redo(): Promise<void>
  signers(): Promise<Signer[]>
  onDocument(handler: (event: DocumentEvent) => void): () => void
  close(): void
}

/** A dictation recorded and transcribed on the iPhone, waiting for its client to be confirmed. */
export interface MobileMemo {
  id: string
  /** When recording started, ISO 8601. The note's date of service comes from this, not from when it arrived. */
  recordedAt: string
  durationSec: number
  transcript: string
  receivedAt: string
}

/** The iPhone link as the renderer sees it: the pairing key never leaves the main process. */
export interface MobileLinkStatus {
  /** off: never set up. waiting: a pairing code exists but no iPhone has used it yet. */
  state: 'off' | 'waiting' | 'paired' | 'error'
  deviceName: string | null
  lastSeenAt: string | null
  message: string
}

/** Raw structured output returned by the model for a note. */
export interface AiNoteResult {
  sections: NoteSection[]
  goal_updates: { goal_id: string; status: GoalStatus; progress: string }[]
  new_goals: { problem: string; goal: string; objectives: string[]; interventions: string }[]
  plan_meta: { frequency: string; modalities: string; discharge_criteria: string } | null
  diagnoses: Diagnosis[]
  context_update: string
  review_items: string[]
}

/** Raw structured output returned by the model when drafting/updating a treatment plan. */
export interface AiPlanResult {
  goals: {
    existing_goal_id: string | null
    problem: string
    goal: string
    objectives: string[]
    interventions: string
    status: GoalStatus
    progress: string
  }[]
  frequency: string
  modalities: string
  discharge_criteria: string
  diagnoses: Diagnosis[]
  context_update: string
  review_items: string[]
}

export interface AiContextResult {
  context_update: string
}

/** A letter written or polished by the model, with the client's name already put back. */
export interface AiLetterResult {
  salutation: string
  body: string
  closing: string
  review_items: string[]
}

export interface EchoApi {
  getState(): Promise<AppState>
  saveSettings(patch: Partial<Settings>): Promise<PublicSettings>
  setApiKey(key: string): Promise<PublicSettings>
  testConnection(): Promise<{ ok: boolean; message: string; models: string[] }>
  upsertClient(client: Client): Promise<void>
  deleteClient(id: string): Promise<void>
  upsertNote(note: Note): Promise<void>
  deleteNote(id: string): Promise<void>
  requestMic(): Promise<boolean>
  /** Transcribes 16 kHz mono PCM16 audio on this Mac. */
  transcribe(pcm: ArrayBuffer): Promise<string>
  transcriberStatus(): Promise<TranscriberStatus>
  onTranscriber(handler: (status: TranscriberStatus) => void): () => void
  updateStatus(): Promise<UpdateStatus>
  onUpdate(handler: (status: UpdateStatus) => void): () => void
  /** Quits and installs a downloaded update. */
  installUpdate(): void
  /** Opens the EHRs from Settings in Chrome and arranges the windows. Resolves with a note for the clinician, if any. */
  openEhrs(): Promise<{ note?: string }>
  /** Brings one EHR (by Ehr.id) to the front in Chrome, ready to paste into. */
  showEhr(id: string): Promise<void>
  /** Opens the live transcription stream; false when there's none to open (demo mode). Events arrive through onLive. */
  liveStart(): Promise<boolean>
  /** 16 kHz mono PCM16 audio for the live stream. */
  liveAudio(pcm: ArrayBuffer): void
  /** Ends the current turn so it's finalized. */
  liveCommit(): void
  liveStop(): Promise<void>
  onLive(handler: (event: LiveEvent) => void): () => void
  /** For each element the note needs, 1 if the dictation so far covers it, else 0. */
  coverage(noteId: string, dictation: string): Promise<Record<string, number>>
  /** `model` overrides the writing model for this note only. */
  generateNote(noteId: string, model?: string): Promise<AiNoteResult>
  amendNote(noteId: string, followUp: string, flagged: string[], model?: string): Promise<AiNoteResult>
  generatePlan(clientId: string, dictation: string): Promise<AiPlanResult>
  /** Rewrites the client's clinical context from every finalized note. */
  rebuildContext(clientId: string): Promise<AiContextResult>
  /** Renders the client's plan to a PDF the clinician picks a location for. Null if cancelled. */
  savePlanPdf(clientId: string): Promise<string | null>
  getLetterhead(): Promise<Letterhead>
  saveLetterhead(letterhead: Letterhead): Promise<void>
  /** Asks for an image file and returns it cropped and scaled as a PNG data URL. Null if cancelled. */
  chooseLetterheadImage(kind: 'logo' | 'signature'): Promise<string | null>
  /** Renders a letter on the letterhead to a PDF the clinician picks a location for. Null if cancelled. */
  saveLetterPdf(letter: Letter, clientName: string): Promise<string | null>
  /** Writes the letter from the clinician's ideas, or polishes their draft. */
  writeLetter(letter: Letter, clientId: string): Promise<AiLetterResult>
  /** A client's Ask Claude chats, newest first. */
  listChats(clientId: string): Promise<ChatSummary[]>
  getChat(threadId: string): Promise<ChatThread | null>
  /**
   * Sends a message, starting a chat if `threadId` is null, and returns the chat with the message added.
   * The reply streams through onChat. With `retry`, the last reply is replaced instead and `text` is ignored.
   */
  sendChat(clientId: string, threadId: string | null, text: string, model: string, retry?: boolean): Promise<ChatThread>
  stopChat(threadId: string): void
  setChatModel(threadId: string, model: string): Promise<ChatThread>
  deleteChat(threadId: string): Promise<void>
  /** Deletes every chat for one client, or for all clients if no ID is given. Returns how many were deleted. */
  deleteAllChats(clientId?: string): Promise<number>
  /** How many finalized notes and Library items Claude would see, and roughly what starting a chat would cost. */
  chatPreview(clientId: string, model: string): Promise<{ notes: number; documents: number; cost: number }>
  onChat(handler: (event: ChatEvent) => void): () => void
  /** Where the resource library is, and whether it's there. */
  resourceFolder(): Promise<{ path: string; found: boolean }>
  /** Asks for the ClinicalResources folder. Null if cancelled. */
  chooseResourceFolder(): Promise<{ path: string; found: boolean } | null>
  /** Opens a resource's web page (ACBS, or an official site) in the browser. */
  openResourceWeb(id: string): Promise<void>
  /** Opens a part's file in its own app (Preview, Word, Keynote…). */
  openResourceApp(id: string, part: number): Promise<void>
  /** Shows a part in the macOS Quick Look panel, for slides and spreadsheets. */
  quickLookResource(id: string, part: number): Promise<void>
  revealResource(id: string): void
  /** Copies a Library resource into the client's documents (as a PDF). */
  /** Gives the client their own copy of a Library resource: every tab, as one document. */
  assignDocument(clientId: string, resourceId: string): Promise<ClientDocument>
  /** Asks for PDFs or images to add to the client's documents. Empty if cancelled. */
  chooseDocumentFiles(clientId: string): Promise<ClientDocument[]>
  /** Adds files dropped from Finder. */
  addDocumentFiles(clientId: string, paths: string[]): Promise<ClientDocument[]>
  /** The path of a file dropped from Finder, for addDocumentFiles. */
  pathForFile(file: File): string
  /** `undoable` adds a step to the document's Undo history, which every window shares. */
  saveDocument(doc: ClientDocument, undoable?: boolean): Promise<void>
  documentHistory(id: string): Promise<DocHistory>
  undoDocument(id: string): Promise<void>
  redoDocument(id: string): Promise<void>
  deleteDocument(id: string): Promise<void>
  /** The document's original PDF. */
  documentBytes(id: string): Promise<Uint8Array>
  /** Saves the finished PDF where the clinician picks. Null if cancelled. */
  exportDocument(id: string): Promise<string | null>
  /** Opens the finished PDF in Preview (from a temporary copy). */
  openDocument(id: string): Promise<void>
  /** Writes the finished PDF to a temporary file ahead of a drag, so the drag can start at once. */
  prepareDocumentDrag(id: string): Promise<void>
  /** Starts dragging the finished PDF out of Echo (into an EHR's upload box, Finder or Mail). */
  dragDocument(id: string): void
  /** Opens the document alone in its own window, to share on screen. */
  /** Opens the document in its presentation window, on `tab` when it has several. */
  presentDocument(id: string, tab?: number): Promise<void>
  /** Closes the document's presentation window. */
  stopPresenting(id: string): void
  onDocument(handler: (event: DocumentEvent) => void): () => void
  saveLetterToDocuments(letter: Letter, clientId: string): Promise<ClientDocument>
  savePlanToDocuments(clientId: string): Promise<ClientDocument>
  copy(text: string, html: string): Promise<void>
  canUseTouchId(): Promise<boolean>
  unlock(): Promise<boolean>
  exportBackup(passphrase: string): Promise<string | null>
  importBackup(passphrase: string): Promise<AppState | null>
  /** Opens a backup from the previous Echo app and lists its clients. Null if no file was chosen. */
  openLegacyBackup(password: string): Promise<LegacyClientSummary[] | null>
  /** Imports one client from the open legacy backup. */
  importLegacyClient(clientId: string): Promise<{ clients: Client[]; notes: Note[]; report: LegacyImportReport; summaries: LegacyClientSummary[] }>
  closeLegacyBackup(): Promise<void>
  linkStatus(): Promise<MobileLinkStatus>
  /** Sets up the iPhone link if needed and returns its pairing QR code as SVG markup. */
  linkPairingCode(): Promise<string>
  /** Forgets the iPhone. Its pairing code stops working and a new one is made next time. */
  linkUnpair(): Promise<MobileLinkStatus>
  onLink(handler: (status: MobileLinkStatus) => void): () => void
  /** Removes a recording from the inbox, once it has become a note or was discarded. */
  removeMemo(id: string): Promise<void>
  onInbox(handler: (inbox: MobileMemo[]) => void): () => void
  onMenu(handler: (command: string) => void): () => void
}

export const GOAL_STATUS_LABEL: Record<GoalStatus, string> = {
  not_started: 'Not started',
  in_progress: 'In progress',
  partially_met: 'Partially met',
  met: 'Met',
  discontinued: 'Discontinued'
}

export const NOTE_TYPE_LABEL: Record<NoteType, string> = {
  intake: 'Intake',
  progress: 'Progress note',
  termination: 'Discharge summary'
}
