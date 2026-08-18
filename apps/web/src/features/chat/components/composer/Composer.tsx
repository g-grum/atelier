import { useEffect, useRef, useState } from 'react'
import type { SlashCommandInfo } from '@atelier/shared'
import { completeMention, insertMention, matchFiles, mentionPrefix, type FileEntry } from '@/features/chat/utils/file-mentions'
import { commandPrefix, completeCommand, matchCommands } from '@/features/chat/utils/slash-commands'
import type { StreamState } from '@/state/stream-reducer'

export type ComposerProps = {
  /** No session selected — dimmed and inert. */
  disabled: boolean
  /** While 'streaming' the action button becomes Stop and submits are no-ops. */
  status: StreamState['status']
  /** Returns whether the controller accepted the message (refused mid-turn). */
  onSend: (text: string) => boolean
  /** Sends the abort ClientMessage — the spec's only way to stop a turn. */
  onAbort: () => void
  /** Liste pour l'autocomplétion. Vide ⇒ aucun popover (dégradation silencieuse). */
  commands: SlashCommandInfo[]
  /** Fichiers/dossiers du projet pour l'autocomplétion @. Vide ⇒ pas de popover. */
  files: FileEntry[]
  /** Upload d'une image (coller/glisser/parcourir) — répond le chemin relatif inséré au caret. */
  onUploadImage: (file: File) => Promise<{ path: string }>
}

/** Growth cap (~8 lines) — beyond it the textarea scrolls internally. */
const MAX_TEXTAREA_HEIGHT_PX = 200

export function Composer({ disabled, status, onSend, onAbort, commands, files, onUploadImage }: ComposerProps) {
  const [text, setText] = useState('')
  const streaming = status === 'streaming'
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Upload d'image : un seul en vol à la fois ; l'erreur s'affiche en ligne et
  // le brouillon est conservé (échec non destructif).
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Position du curseur : le déclenchement du popover en dépend (revenir dans
  // le premier mot rouvre l'autocomplétion, en sortir la ferme).
  const [caret, setCaret] = useState(0)
  const [active, setActive] = useState(0)
  // Fermeture explicite (Esc, ou complétion qui vient d'aboutir) : sans ça le
  // nom complété — un préfixe valide de lui-même — rouvrirait le popover.
  const [dismissed, setDismissed] = useState(false)
  const activeRef = useRef<HTMLLIElement>(null)

  const cmdPrefix = dismissed ? null : commandPrefix(text, caret)
  const cmdMatches = cmdPrefix === null ? [] : matchCommands(commands, cmdPrefix)
  const filePrefix = dismissed || cmdMatches.length > 0 ? null : mentionPrefix(text, caret)
  const fileMatches = filePrefix === null ? [] : matchFiles(files, filePrefix)
  const matches = cmdMatches.length > 0 ? cmdMatches : fileMatches
  const open = matches.length > 0

  // Garde la sélection clavier visible quand la liste dépasse la hauteur du
  // popover. happy-dom n'implémente pas scrollIntoView — appel optionnel.
  useEffect(() => {
    activeRef.current?.scrollIntoView?.({ block: 'nearest' })
  }, [active])

  const uploadFile = async (file: File) => {
    if (uploading) return
    setUploadError(null)
    setUploading(true)
    try {
      const { path } = await onUploadImage(file)
      // Insère au caret courant (l'état `caret` est géré par le composer).
      const next = insertMention(text, caret, path)
      setText(next.text)
      setCaret(next.caret)
      setDismissed(true)
      textareaRef.current?.focus()
    } catch {
      setUploadError("Image upload failed.")
    } finally {
      setUploading(false)
    }
  }

  const complete = (name: string) => {
    const next = completeCommand(text, name)
    setText(next)
    setCaret(next.length)
    setDismissed(true)
    textareaRef.current?.focus()
  }

  const completeFile = (entry: FileEntry) => {
    const next = completeMention(text, caret, entry)
    setText(next.text)
    setCaret(next.caret)
    // Fichier : fermer (le chemin complété rematcherait). Dossier : rester
    // ouvert pour descendre dans l'arborescence.
    setDismissed(!entry.dir)
    setActive(0)
    const el = textareaRef.current
    el?.focus()
    // React replace la valeur ⇒ le caret DOM saute en fin ; on le repose au
    // point d'insertion (mention en milieu de phrase). happy-dom : optionnel.
    requestAnimationFrame(() => el?.setSelectionRange?.(next.caret, next.caret))
  }

  // Autofocus when a session becomes active (fresh draft or opened session):
  // the user can start typing without clicking the textarea first. Runs only
  // on the disabled→enabled transition, so it never steals focus mid-use.
  useEffect(() => {
    if (!disabled) textareaRef.current?.focus()
  }, [disabled])

  // Auto-grow: the textarea follows its content up to a cap, then scrolls.
  // 'auto' first so a shrinking draft (deleted lines, post-send reset) can
  // shrink back; scrollHeight 0 = no layout (tests) — leave the height alone.
  useEffect(() => {
    const el = textareaRef.current
    if (el === null) return
    el.style.height = 'auto'
    if (el.scrollHeight > 0) el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT_PX)}px`
  }, [text])

  const trySend = () => {
    const trimmed = text.trim()
    if (trimmed === '') return
    // Mid-turn sends are accepted and QUEUED by the controller (sent at next
    // idle) — the composer no longer blocks them. Keep the draft only when the
    // controller refuses outright (no socket / resync in flight).
    if (onSend(trimmed)) setText('')
  }

  return (
    <div className="composer">
      {cmdMatches.length > 0 && (
        // Popover écrit à la main : components/ui/ n'a aucune primitive listbox.
        <ul className="command-popover" role="listbox" aria-label="Available commands">
          {cmdMatches.map((command, index) => (
            <li
              key={command.name}
              ref={index === active ? activeRef : undefined}
              role="option"
              aria-selected={index === active}
              className={index === active ? 'active' : undefined}
              // onMouseMove, pas onMouseEnter : quand la liste défile sous un
              // curseur immobile (navigation clavier), onMouseEnter volerait la
              // sélection ; onMouseMove n'active que si la souris bouge vraiment.
              onMouseMove={() => setActive(index)}
              // onMouseDown, pas onClick : onClick arriverait APRÈS le blur de
              // la textarea, qui aurait déjà fermé le popover.
              onMouseDown={(event) => {
                event.preventDefault()
                complete(command.name)
              }}
            >
              <span className="cmd-name">/{command.name}</span>
              {command.argumentHint !== '' && <span className="cmd-hint">{command.argumentHint}</span>}
              <span className="cmd-desc">{command.description}</span>
            </li>
          ))}
        </ul>
      )}
      {open && cmdMatches.length === 0 && (
        <ul className="command-popover" role="listbox" aria-label="Project files">
          {fileMatches.map((entry, index) => (
            <li
              key={entry.path}
              ref={index === active ? activeRef : undefined}
              role="option"
              aria-selected={index === active}
              className={index === active ? 'active' : undefined}
              onMouseMove={() => setActive(index)}
              onMouseDown={(event) => {
                event.preventDefault()
                completeFile(entry)
              }}
            >
              <span className="cmd-name">{entry.path}{entry.dir ? '/' : ''}</span>
            </li>
          ))}
        </ul>
      )}
      <div className={`box${disabled ? ' disabled' : ''}`}>
        <textarea
          ref={textareaRef}
          rows={1}
          value={text}
          disabled={disabled}
          placeholder="Reply to Claude…"
          aria-label="Reply to Claude"
          onChange={(event) => {
            setText(event.target.value)
            setCaret(event.target.selectionStart ?? 0)
            setActive(0)
            setDismissed(false)
            setUploadError(null)
          }}
          onPaste={(event) => {
            const item = Array.from(event.clipboardData?.items ?? []).find(
              (i) => i.kind === 'file' && i.type.startsWith('image/'),
            )
            const file = item?.getAsFile()
            if (file) {
              event.preventDefault()
              void uploadFile(file)
            }
          }}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            const file = Array.from(event.dataTransfer?.files ?? []).find((f) => f.type.startsWith('image/'))
            if (file) {
              event.preventDefault()
              void uploadFile(file)
            }
          }}
          onKeyDown={(event) => {
            // Deux échappatoires INCONDITIONNELLES, même popover ouvert :
            //  - ⌘↵ envoie (testé explicitement)
            //  - Shift+Enter insère une nouvelle ligne — sans le !shiftKey, le
            //    popover volerait le saut de ligne dès le premier mot.
            if (open && !event.metaKey && !event.shiftKey) {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setActive((i) => (i + 1) % matches.length)
                return
              }
              if (event.key === 'ArrowUp') {
                event.preventDefault()
                setActive((i) => (i - 1 + matches.length) % matches.length)
                return
              }
              if (event.key === 'Enter' || event.key === 'Tab') {
                event.preventDefault()
                // `active` peut dépasser la liste si `commands`/`files` a rétréci
                // (refetch, push WS) depuis la dernière frappe — on garde l'accès.
                const cmd = cmdMatches[active]
                const file = fileMatches[active]
                if (cmd !== undefined) complete(cmd.name)
                else if (file !== undefined) completeFile(file)
                return
              }
              if (event.key === 'Escape') {
                event.preventDefault()
                setDismissed(true)
                return
              }
            }
            // ⌘↵ always sends; plain Enter sends too (Shift+Enter = newline).
            if (event.key === 'Enter' && (event.metaKey || !event.shiftKey)) {
              event.preventDefault()
              trySend()
            }
          }}
        />
        <kbd>⌘↵</kbd>
        <button
          type="button"
          className="attach"
          disabled={disabled || uploading}
          aria-label="Add an image"
          onClick={() => fileInputRef.current?.click()}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <path d="m21 15-5-5L5 21" />
          </svg>
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) void uploadFile(file)
            event.target.value = ''
          }}
        />
        <button
          type="button"
          className={`action${streaming ? ' stop' : ''}`}
          disabled={disabled}
          aria-label={streaming ? 'Stop generation' : 'Send message'}
          onClick={streaming ? onAbort : trySend}
        >
          {streaming ? (
            // Square = stop; red accent (never amber — that is permissions-only).
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 19V5" />
              <path d="m5 12 7-7 7 7" />
            </svg>
          )}
        </button>
      </div>
      {uploading && <p className="composer-upload-status" aria-live="polite">Uploading image…</p>}
      {uploadError !== null && <p className="composer-upload-error" role="alert">{uploadError}</p>}
    </div>
  )
}
