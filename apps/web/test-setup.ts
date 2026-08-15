import { GlobalRegistrator } from '@happy-dom/global-registrator'

// Base URL so relative resource URLs (img src="/api/…") resolve instead of
// erroring against about:blank — happy-dom fires `error` on unresolvable srcs,
// which would flip image components into their failure state at mount.
GlobalRegistrator.register({ url: 'http://localhost/' })
