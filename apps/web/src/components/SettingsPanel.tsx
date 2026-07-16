import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Settings } from 'lucide-react'
import { useState } from 'react'
import { MODELS, type AlwaysRule, type Preferences, type ProjectSummary } from '@atelier/shared'
import * as client from '../api/client'
import { modelLabel } from '../lib/models'
import { basename, errorMessage } from '../lib/utils'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from './ui/dialog'

/** The slice of the REST client the panel needs — injectable for tests. */
export type SettingsApi = {
  getPreferences: typeof client.getPreferences
  patchPreferences: typeof client.patchPreferences
  listRules: typeof client.listRules
  deleteRule: typeof client.deleteRule
  listProjects: typeof client.listProjects
  deleteProject: typeof client.deleteProject
}

const defaultApi: SettingsApi = {
  getPreferences: client.getPreferences,
  patchPreferences: client.patchPreferences,
  listRules: client.listRules,
  deleteRule: client.deleteRule,
  listProjects: client.listProjects,
  deleteProject: client.deleteProject,
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
          aria-label="Réglages"
          title="Réglages"
          className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-[7px] border border-transparent bg-transparent p-0 text-muted hover:border-line hover:bg-surface-2 hover:text-text"
        >
          <Settings className="h-4 w-4" aria-hidden="true" />
        </button>
      </DialogTrigger>
      <DialogContent className="bg-surface sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle className="text-[15px]">Réglages</DialogTitle>
          <DialogDescription>Préférences de l’atelier et règles d’autorisation.</DialogDescription>
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
      setNotice(`Impossible d’enregistrer la préférence : ${errorMessage(error)}`)
      void queryClient.invalidateQueries({ queryKey: ['preferences'] }) // restore server truth
    },
  })

  const removeRule = useMutation({
    mutationFn: api.deleteRule,
    onSuccess: () => {
      setNotice(null)
      return queryClient.invalidateQueries({ queryKey: ['rules'] })
    },
    onError: (error) => setNotice(`Impossible de supprimer la règle : ${errorMessage(error)}`),
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
      setNotice(`Impossible de retirer le projet : ${errorMessage(error)}`)
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
          IDE préféré
        </label>
        {prefsQuery.isPending ? (
          <p className={HINT_CLASS}>Chargement…</p>
        ) : prefs === undefined ? (
          <LoadError what="les préférences" error={prefsQuery.error} onRetry={() => void prefsQuery.refetch()} />
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
        <p className={HINT_CLASS}>Utilisé pour « Ouvrir dans l’IDE ».</p>
      </section>

      <section className="flex flex-col gap-2">
        <label className={LABEL_CLASS} htmlFor="settings-model">
          Modèle par défaut
        </label>
        {prefsQuery.isPending ? (
          <p className={HINT_CLASS}>Chargement…</p>
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
        <p className={HINT_CLASS}>Appliqué aux nouvelles sessions.</p>
      </section>

      <section className="flex flex-col gap-2">
        <h3 className={`m-0 ${LABEL_CLASS}`}>Règles « toujours autoriser »</h3>
        {rulesQuery.isPending ? (
          <p className={HINT_CLASS}>Chargement…</p>
        ) : rulesQuery.data === undefined ? (
          <LoadError what="les règles" error={rulesQuery.error} onRetry={() => void rulesQuery.refetch()} />
        ) : rulesQuery.data.length === 0 ? (
          <p className="m-0 text-xs text-muted">Aucune règle « toujours autoriser » enregistrée.</p>
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
        <p className={HINT_CLASS}>Supprimer une règle rétablit la demande de permission au prochain usage.</p>
      </section>

      <section className="flex flex-col gap-2">
        <h3 className={`m-0 ${LABEL_CLASS}`}>Projets</h3>
        {projectsQuery.isPending ? (
          <p className={HINT_CLASS}>Chargement…</p>
        ) : projectsQuery.data === undefined ? (
          <LoadError what="les projets" error={projectsQuery.error} onRetry={() => void projectsQuery.refetch()} />
        ) : projectsQuery.data.length === 0 ? (
          <p className="m-0 text-xs text-muted">Aucun projet enregistré.</p>
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
        <p className={HINT_CLASS}>Retirer le projet (les conversations restent dans ~/.claude)</p>
      </section>
    </div>
  )
}

function RuleRow({ rule, deleting, onDelete }: { rule: AlwaysRule; deleting: boolean; onDelete: () => void }) {
  const matcherLabel = rule.matcher ?? 'outil entier'
  return (
    <li className="flex items-center gap-2 rounded-lg border border-line-soft bg-ground px-3 py-2 font-mono text-[11.5px] text-muted">
      <span className="min-w-0 [overflow-wrap:anywhere]">
        <span className="font-bold text-text">{rule.toolName}</span>
        <span className="text-faint"> : </span>
        {rule.matcher !== null ? rule.matcher : <span className="italic text-faint">outil entier</span>}
      </span>
      <button
        type="button"
        aria-label={`Supprimer la règle « ${rule.toolName} : ${matcherLabel} »`}
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
          aria-label={`Confirmer le retrait de « ${name} »`}
          disabled={deleting}
          onClick={onConfirm}
          className="ml-auto flex-shrink-0 cursor-pointer rounded-[5px] border-0 bg-red/10 px-2 py-0.5 text-[11px] font-bold text-red hover:bg-red/20 disabled:cursor-default disabled:opacity-50"
        >
          Confirmer le retrait ?
        </button>
      ) : (
        <button
          type="button"
          aria-label={`Retirer le projet « ${name} »`}
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
        Impossible de charger {what} : {errorMessage(error)}
      </span>
      <button
        type="button"
        onClick={onRetry}
        className="flex-shrink-0 cursor-pointer rounded-[7px] border border-line bg-surface-2 px-2.5 py-1 text-[11px] font-bold text-text hover:border-red hover:text-red"
      >
        Réessayer
      </button>
    </div>
  )
}
