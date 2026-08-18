import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Settings } from 'lucide-react'
import { useState } from 'react'
import { MODELS, type AlwaysRule, type Preferences, type ProjectSummary, type SessionPermissionMode, type Theme } from '@atelier/shared'
import { type Backend, backend } from '@/api/backend'
import { modelLabel } from '@/features/settings/utils/models'
import { applyTheme } from '@/features/settings/utils/theme'
import { basename } from '@atelier/core/utils/basename'
import { errorMessage } from '@atelier/core/utils/error-message'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/ui/dialog/dialog'

/** The slice of the Backend seam the panel needs — injectable for tests. */
export type SettingsApi = Pick<
  Backend,
  'getPreferences' | 'patchPreferences' | 'listRules' | 'deleteRule' | 'listProjects' | 'deleteProject'
>

/** Exported for tests: proves the default wiring goes through the seam (fixtures included). */
export const defaultApi: SettingsApi = {
  getPreferences: backend.getPreferences,
  patchPreferences: backend.patchPreferences,
  listRules: backend.listRules,
  deleteRule: backend.deleteRule,
  listProjects: backend.listProjects,
  deleteProject: backend.deleteProject,
}

const IDE_LABELS: Record<Preferences['ide'], string> = {
  webstorm: 'WebStorm',
  vscode: 'VS Code',
  cursor: 'Cursor',
  idea: 'IntelliJ IDEA',
}
const IDES = Object.keys(IDE_LABELS) as Preferences['ide'][]

const LABEL_CLASS = 'font-mono text-[10px] font-bold uppercase tracking-[0.1em] text-faint'
const HINT_CLASS = 'm-0 text-[11.5px] text-faint'
const SELECT_CLASS =
  'w-full rounded-[7px] border border-line bg-ground px-2.5 py-[7px] font-mono text-xs text-text outline-none ' +
  'focus:border-indigo focus:shadow-[0_0_0_3px_rgba(124,134,255,0.12)] disabled:opacity-60'

/**
 * Gear trigger + settings dialog: IDE preference, default model, and the
 * always-allow rules list (the spec's day-one requirement — a mistaken
 * « toujours » must be revocable in-app). Queries run only while the dialog
 * is open (Radix unmounts closed content), so under VITE_USE_FIXTURES —
 * where there is no server — the closed panel costs nothing and an opened
 * one degrades to its inline error states instead of crashing.
 */
export function SettingsPanel({ api = defaultApi }: { api?: SettingsApi }) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          aria-label="Settings"
          title="Settings"
          data-tour="settings"
          className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-[7px] border border-transparent bg-transparent p-0 text-muted hover:border-line hover:bg-surface-2 hover:text-text"
        >
          <Settings className="h-4 w-4" aria-hidden="true" />
        </button>
      </DialogTrigger>
      <DialogContent className="bg-surface sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle className="text-[15px]">Settings</DialogTitle>
          <DialogDescription>Workspace preferences and permission rules.</DialogDescription>
        </DialogHeader>
        <SettingsBody api={api} />
      </DialogContent>
    </Dialog>
  )
}

function SettingsBody({ api }: { api: SettingsApi }) {
  const queryClient = useQueryClient()
  /** Transient failure notice from mutations (patch preference / delete rule). */
  const [notice, setNotice] = useState<string | null>(null)

  const prefsQuery = useQuery({ queryKey: ['preferences'], queryFn: api.getPreferences })
  const rulesQuery = useQuery({ queryKey: ['rules'], queryFn: api.listRules })
  // SHARED key with App's sidebar query: invalidating it below refreshes both
  // lists at once. Under fixtures, opening the dialog refetches this key with
  // the REST queryFn, which FAILS: react-query keeps the cached data but flips
  // the status to 'error' — App masks error-with-data as 'success' so the
  // sidebar keeps its rendered list (this section shows its own retry card).
  const projectsQuery = useQuery({ queryKey: ['projects'], queryFn: api.listProjects })

  /**
   * Two-step unregister: the armed row shows « Confirmer le retrait ? » and only
   * its second click deletes. At most one row is armed; arming another row
   * disarms the previous one, and closing the dialog resets the state (Radix
   * unmounts closed content). No click-elsewhere disarm — kept simple on purpose.
   */
  const [armedProjectId, setArmedProjectId] = useState<string | null>(null)

  const patchPrefs = useMutation({
    mutationFn: api.patchPreferences,
    // Optimistic: the select must not snap back while the PATCH is in flight.
    onMutate: (patch) => {
      setNotice(null)
      queryClient.setQueryData<Preferences>(['preferences'], (old) => (old === undefined ? old : { ...old, ...patch }))
    },
    onSuccess: (prefs) => queryClient.setQueryData(['preferences'], prefs),
    onError: (error) => {
      setNotice(`Could not save the preference: ${errorMessage(error)}`)
      void queryClient.invalidateQueries({ queryKey: ['preferences'] }) // restore server truth
    },
  })

  const removeRule = useMutation({
    mutationFn: api.deleteRule,
    onSuccess: () => {
      setNotice(null)
      return queryClient.invalidateQueries({ queryKey: ['rules'] })
    },
    onError: (error) => setNotice(`Could not delete the rule: ${errorMessage(error)}`),
  })

  const removeProject = useMutation({
    mutationFn: api.deleteProject,
    onSuccess: () => {
      setNotice(null)
      setArmedProjectId(null)
      return queryClient.invalidateQueries({ queryKey: ['projects'] })
    },
    onError: (error) => {
      setArmedProjectId(null) // a failed retrait must be re-confirmed from scratch
      setNotice(`Could not remove the project: ${errorMessage(error)}`)
    },
  })

  const prefs = prefsQuery.data

  return (
    <div className="flex flex-col gap-5">
      {notice !== null && (
        <p role="alert" className="m-0 rounded-lg border border-red/40 border-l-[3px] border-l-red bg-surface-2 px-3 py-2 text-xs [overflow-wrap:anywhere]">
          {notice}
        </p>
      )}

      <section className="flex flex-col gap-2">
        <label className={LABEL_CLASS} htmlFor="settings-ide">
          Preferred IDE
        </label>
        {prefsQuery.isPending ? (
          <p className={HINT_CLASS}>Loading…</p>
        ) : prefs === undefined ? (
          <LoadError what="the preferences" error={prefsQuery.error} onRetry={() => void prefsQuery.refetch()} />
        ) : (
          <select
            id="settings-ide"
            className={SELECT_CLASS}
            value={prefs.ide}
            disabled={patchPrefs.isPending}
            onChange={(event) => patchPrefs.mutate({ ide: event.target.value as Preferences['ide'] })}
          >
            {IDES.map((ide) => (
              <option key={ide} value={ide}>
                {IDE_LABELS[ide]}
              </option>
            ))}
          </select>
        )}
        <p className={HINT_CLASS}>Used for “Open in IDE”.</p>
      </section>

      <section className="flex flex-col gap-2">
        <label className={LABEL_CLASS} htmlFor="settings-model">
          Default model
        </label>
        {prefsQuery.isPending ? (
          <p className={HINT_CLASS}>Loading…</p>
        ) : prefs === undefined ? null : (
          <select
            id="settings-model"
            className={SELECT_CLASS}
            value={prefs.defaultModel}
            disabled={patchPrefs.isPending}
            onChange={(event) => patchPrefs.mutate({ defaultModel: event.target.value })}
          >
            {MODELS.map((model) => (
              <option key={model} value={model}>
                {modelLabel(model)}
              </option>
            ))}
            {/* A persisted model no longer in MODELS must stay selectable, not silently remapped. */}
            {!MODELS.includes(prefs.defaultModel as (typeof MODELS)[number]) && (
              <option value={prefs.defaultModel}>{prefs.defaultModel}</option>
            )}
          </select>
        )}
        <p className={HINT_CLASS}>Applied to new sessions.</p>
      </section>

      <section className="flex flex-col gap-2">
        <label className={LABEL_CLASS} htmlFor="settings-theme">
          Theme
        </label>
        {prefsQuery.isPending ? (
          <p className={HINT_CLASS}>Loading…</p>
        ) : prefs === undefined ? null : (
          <select
            id="settings-theme"
            className={SELECT_CLASS}
            value={prefs.theme ?? 'dark'}
            disabled={patchPrefs.isPending}
            onChange={(event) => {
              const theme = event.target.value as Theme
              applyTheme(theme) // change le thème DOM immédiatement (le toggle topbar suit via son MutationObserver)
              patchPrefs.mutate({ theme }) // persiste (optimiste, comme les autres rangées)
            }}
          >
            <option value="dark">Dark</option>
            <option value="light">Light</option>
          </select>
        )}
        <p className={HINT_CLASS}>Also toggled via the ☀︎/☾ icon in the top bar.</p>
      </section>

      <section className="flex flex-col gap-2">
        <label className={LABEL_CLASS} htmlFor="settings-permissions">
          New-session permissions
        </label>
        {prefsQuery.isPending ? (
          <p className={HINT_CLASS}>Loading…</p>
        ) : prefs === undefined ? null : (
          <select
            id="settings-permissions"
            // Le skip est un état dangereux : la valeur sélectionnée s'affiche en rouge
            // (l'ambre reste réservé aux prompts de permissions — charte).
            className={`${SELECT_CLASS}${prefs.defaultPermissionMode === 'bypassPermissions' ? ' text-red' : ''}`}
            value={prefs.defaultPermissionMode ?? ''}
            disabled={patchPrefs.isPending}
            onChange={(event) =>
              patchPrefs.mutate({
                defaultPermissionMode: event.target.value === '' ? null : (event.target.value as SessionPermissionMode),
              })
            }
          >
            <option value="">Ask for each session</option>
            <option value="default">Normal permissions</option>
            <option value="bypassPermissions">Skip permissions (dangerous)</option>
          </select>
        )}
        <p className={HINT_CLASS}>Applies to new sessions only — existing sessions keep their mode.</p>
      </section>

      <section className="flex flex-col gap-2">
        <h3 className={`m-0 ${LABEL_CLASS}`}>“Always allow” rules</h3>
        {rulesQuery.isPending ? (
          <p className={HINT_CLASS}>Loading…</p>
        ) : rulesQuery.data === undefined ? (
          <LoadError what="the rules" error={rulesQuery.error} onRetry={() => void rulesQuery.refetch()} />
        ) : rulesQuery.data.length === 0 ? (
          <p className="m-0 text-xs text-muted">No “always allow” rule recorded.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {rulesQuery.data.map((rule) => (
              <RuleRow
                key={rule.id}
                rule={rule}
                deleting={removeRule.isPending && removeRule.variables === rule.id}
                onDelete={() => removeRule.mutate(rule.id)}
              />
            ))}
          </ul>
        )}
        <p className={HINT_CLASS}>Deleting a rule restores the permission prompt on next use.</p>
      </section>

      <section className="flex flex-col gap-2">
        <h3 className={`m-0 ${LABEL_CLASS}`}>Projects</h3>
        {projectsQuery.isPending ? (
          <p className={HINT_CLASS}>Loading…</p>
        ) : projectsQuery.data === undefined ? (
          <LoadError what="the projects" error={projectsQuery.error} onRetry={() => void projectsQuery.refetch()} />
        ) : projectsQuery.data.length === 0 ? (
          <p className="m-0 text-xs text-muted">No registered projects.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {projectsQuery.data.map((project) => (
              <ProjectRow
                key={project.id}
                project={project}
                armed={armedProjectId === project.id}
                deleting={removeProject.isPending && removeProject.variables === project.id}
                onArm={() => setArmedProjectId(project.id)}
                onConfirm={() => removeProject.mutate(project.id)}
              />
            ))}
          </ul>
        )}
        <p className={HINT_CLASS}>Removing a project keeps its conversations in ~/.claude</p>
      </section>
    </div>
  )
}

function RuleRow({ rule, deleting, onDelete }: { rule: AlwaysRule; deleting: boolean; onDelete: () => void }) {
  const matcherLabel = rule.matcher ?? 'entire tool'
  return (
    <li className="flex items-center gap-2 rounded-lg border border-line-soft bg-ground px-3 py-2 font-mono text-[11.5px] text-muted">
      <span className="min-w-0 [overflow-wrap:anywhere]">
        <span className="font-bold text-text">{rule.toolName}</span>
        <span className="text-faint"> : </span>
        {rule.matcher !== null ? rule.matcher : <span className="italic text-faint">entire tool</span>}
      </span>
      <button
        type="button"
        aria-label={`Delete the rule “${rule.toolName}: ${matcherLabel}”`}
        disabled={deleting}
        onClick={onDelete}
        className="ml-auto flex h-5 w-5 flex-shrink-0 cursor-pointer items-center justify-center rounded-[5px] border-0 bg-transparent p-0 text-sm leading-none text-faint hover:bg-red/10 hover:text-red disabled:cursor-default disabled:opacity-50"
      >
        ×
      </button>
    </li>
  )
}

function ProjectRow({
  project,
  armed,
  deleting,
  onArm,
  onConfirm,
}: {
  project: ProjectSummary
  armed: boolean
  deleting: boolean
  onArm: () => void
  onConfirm: () => void
}) {
  const name = basename(project.path)
  return (
    <li className="flex items-center gap-2 rounded-lg border border-line-soft bg-ground px-3 py-2 font-mono text-[11.5px] text-muted">
      <span className="min-w-0 font-bold text-text [overflow-wrap:anywhere]" title={project.path}>
        {name}
      </span>
      {armed ? (
        <button
          type="button"
          aria-label={`Confirm removing “${name}”`}
          disabled={deleting}
          onClick={onConfirm}
          className="ml-auto flex-shrink-0 cursor-pointer rounded-[5px] border-0 bg-red/10 px-2 py-0.5 text-[11px] font-bold text-red hover:bg-red/20 disabled:cursor-default disabled:opacity-50"
        >
          Confirm removal?
        </button>
      ) : (
        <button
          type="button"
          aria-label={`Remove the project “${name}”`}
          disabled={deleting}
          onClick={onArm}
          className="ml-auto flex h-5 w-5 flex-shrink-0 cursor-pointer items-center justify-center rounded-[5px] border-0 bg-transparent p-0 text-sm leading-none text-faint hover:bg-red/10 hover:text-red disabled:cursor-default disabled:opacity-50"
        >
          ×
        </button>
      )}
    </li>
  )
}

function LoadError({ what, error, onRetry }: { what: string; error: unknown; onRetry: () => void }) {
  return (
    <div role="alert" className="flex items-center gap-2.5 rounded-lg border border-red/40 border-l-[3px] border-l-red bg-surface-2 px-3 py-2 text-xs">
      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
        Could not load {what}: {errorMessage(error)}
      </span>
      <button
        type="button"
        onClick={onRetry}
        className="flex-shrink-0 cursor-pointer rounded-[7px] border border-line bg-surface-2 px-2.5 py-1 text-[11px] font-bold text-text hover:border-red hover:text-red"
      >
        Retry
      </button>
    </div>
  )
}
