/**
 * Garde anti-orphelin (--watch-stdin) : le shell Electron spawn le serveur avec
 * stdin en pipe ; si le shell meurt SANS passer par quit (SIGKILL, crash), l'OS
 * ferme le pipe et le serveur s'éteint au lieu de squatter le port 4517.
 * Opt-in par flag : un lancement terminal (stdin TTY ou fermé) ne doit pas mourir.
 */
type StdinLike = {
  on(event: string, listener: () => void): unknown
  resume(): void
}

export function watchStdin(stdin: StdinLike, onOrphaned: () => void): void {
  let fired = false
  const fire = () => {
    if (fired) return
    fired = true
    onOrphaned()
  }
  stdin.on('end', fire)
  stdin.on('close', fire)
  // Sans consommateur le flux reste en pause et 'end' n'est jamais émis.
  stdin.resume()
}
