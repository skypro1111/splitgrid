import { toast } from './Toast';

// Shown when the user clicks a terminal's "Stream to web" toggle while signed
// out. Web streaming needs a WorkOS access token, so we can't stream until they
// sign in — the toast offers a one-click Sign in that kicks off the AuthKit flow
// (it completes in the system browser; onAuthChanged then re-enables the toggle).
export function promptStreamLogin(): void {
  toast('For remote terminal you have to login', {
    type: 'info',
    duration: 4000,
    action: {
      label: 'Sign in',
      onClick: () => { void window.electronAPI.authLogin().catch(() => { /* user can retry */ }); },
    },
  });
}
