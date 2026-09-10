import { el } from "./dom";
import { MIN_PASSWORD_LENGTH } from "../engine/auth/types";
import type { AuthController } from "../engine/auth/AuthController";

export type AuthDialogOptions = {
  auth: AuthController;
};

export type AuthDialog = {
  /** The overlay - main.ts appends it to document.body, outside the shell's grid. */
  element: HTMLElement;
  /**
   * Shows the dialog in sign-in mode. `reason` says why it opened ("Sign in
   * to save your project."). Resolves true once the user is signed in, and
   * false if they close it first.
   */
  open: (reason?: string) => Promise<boolean>;
  close: () => void;
};

type Mode = "sign-in" | "sign-up";

const DEFAULT_REASON = "Sign in to save your projects and open them again later.";

/**
 * Sign in / Create account: one email-and-password form with two modes.
 * It only calls AuthController.signIn()/signUp() and renders the
 * controller's state - it never sees a token or talks to the server
 * itself. It closes once the user is signed in. "Continue without an
 * account" closes it too: modelling works signed out; saving, opening and
 * the AI assistant need an account.
 */
export function createAuthDialog(options: AuthDialogOptions): AuthDialog {
  let mode: Mode = "sign-in";
  // Only show the controller's message once this dialog has sent something -
  // not a leftover "Signed out." from before it opened.
  let submitted = false;
  let pending: ((signedIn: boolean) => void) | null = null;

  const title = el("h2", { className: "auth-dialog__title", attrs: { id: "auth-dialog-title" } });
  const closeButton = el("button", { className: "toolbar-button", text: "Close", attrs: { type: "button" } });
  const reason = el("p", { className: "auth-dialog__reason" });

  const email = el("input", {
    className: "auth-dialog__input",
    attrs: { type: "email", name: "email", autocomplete: "email", spellcheck: "false", required: "" }
  });
  const password = el("input", {
    className: "auth-dialog__input",
    attrs: { type: "password", name: "password", minlength: String(MIN_PASSWORD_LENGTH), required: "" }
  });
  const field = (label: string, input: HTMLInputElement) =>
    el("label", { className: "auth-dialog__field" }, [el("span", { className: "auth-dialog__label", text: label }), input]);

  const message = el("p", { className: "auth-dialog__message", attrs: { role: "alert" } });
  const submit = el("button", { className: "toolbar-button toolbar-button--primary", attrs: { type: "submit" } });
  const switchMode = el("button", { className: "auth-dialog__link", attrs: { type: "button" } });
  const skip = el("button", { className: "toolbar-button", text: "Continue without an account", attrs: { type: "button" } });

  // novalidate: credentialsProblem() (the same rule the server applies)
  // gives the message, rather than each browser's own bubble.
  const form = el("form", { className: "auth-dialog__form", attrs: { novalidate: "" } }, [
    field("Email", email),
    field("Password", password),
    message,
    el("div", { className: "auth-dialog__actions" }, [submit, switchMode])
  ]);

  const panel = el(
    "div",
    { className: "auth-dialog__panel", attrs: { role: "dialog", "aria-modal": "true", "aria-labelledby": "auth-dialog-title" } },
    [
      el("div", { className: "auth-dialog__header" }, [title, closeButton]),
      reason,
      form,
      el("div", { className: "auth-dialog__footer" }, [skip])
    ]
  );
  const overlay = el("div", { className: "auth-dialog" }, [panel]);
  overlay.hidden = true;

  function render(): void {
    const state = options.auth.getState();
    const working = state.status === "working";
    const signIn = mode === "sign-in";
    title.textContent = signIn ? "Sign in" : "Create an account";
    submit.textContent = working ? (signIn ? "Signing in…" : "Creating account…") : signIn ? "Sign in" : "Create account";
    switchMode.textContent = signIn ? "New here? Create an account" : "Have an account? Sign in";
    password.setAttribute("autocomplete", signIn ? "current-password" : "new-password");
    password.placeholder = signIn ? "" : `At least ${MIN_PASSWORD_LENGTH} characters`;
    email.disabled = working;
    password.disabled = working;
    submit.disabled = working;
    switchMode.disabled = working;
    const text = submitted && !working ? (state.message ?? "") : "";
    message.textContent = text;
    message.hidden = text.length === 0;
  }

  function finish(signedIn: boolean): void {
    overlay.hidden = true;
    password.value = "";
    const resolve = pending;
    pending = null;
    resolve?.(signedIn);
  }

  const close = () => finish(false);

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (options.auth.getState().status === "working") {
      return;
    }
    submitted = true;
    const attempt = mode === "sign-in" ? options.auth.signIn(email.value, password.value) : options.auth.signUp(email.value, password.value);
    void attempt.then((signedIn) => {
      if (signedIn) {
        finish(true);
      } else {
        password.focus();
      }
    });
  });

  switchMode.addEventListener("click", () => {
    mode = mode === "sign-in" ? "sign-up" : "sign-in";
    submitted = false;
    render();
    email.focus();
  });
  closeButton.addEventListener("click", close);
  skip.addEventListener("click", close);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) {
      close(); // a click on the backdrop, not the panel
    }
  });
  overlay.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      close();
    }
  });

  options.auth.subscribe(() => {
    if (!overlay.hidden) {
      render();
    }
  });

  return {
    element: overlay,
    open: (why?: string) => {
      pending?.(false);
      mode = "sign-in";
      submitted = false;
      reason.textContent = why ?? DEFAULT_REASON;
      overlay.hidden = false;
      render();
      email.focus();
      return new Promise<boolean>((resolve) => {
        pending = resolve;
      });
    },
    close
  };
}
