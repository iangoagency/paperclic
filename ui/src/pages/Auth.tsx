import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "@/lib/router";
import { authApi } from "../api/auth";
import { healthApi } from "../api/health";
import { CloudSignIn } from "@/components/CloudSignIn";
import { clearCloudSignInAttempt } from "@/lib/cloud-sign-in";
import { tenantSignInReturnPath } from "@/lib/cloudLinks";
import { queryKeys } from "../lib/queryKeys";
import { getRememberedInvitePath } from "../lib/invite-memory";
import { Button } from "@/components/ui/button";
import { AsciiArtAnimation } from "@/components/AsciiArtAnimation";
import { PaperclipLoading } from "@/components/AnimatedPaperclipIcon";
import { ThemeToggle } from "@/components/ThemeToggle";
import { PaperclipLockup } from "../components/PaperclipLockup";

type AuthMode = "sign_in" | "sign_up";

// Must match the code length the server emails (server/src/auth/email-code.ts).
const SIGN_IN_CODE_LENGTH = 8;

export function AuthPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [mode, setMode] = useState<AuthMode>("sign_in");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Set once a sign-in code has been emailed; the form then asks for that code.
  const [codeSentTo, setCodeSentTo] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const errorId = "auth-error";

  const nextPath = useMemo(
    () => tenantSignInReturnPath(searchParams.get("next") || getRememberedInvitePath() || "/"),
    [searchParams],
  );
  const healthQuery = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    retry: false,
  });
  const { data: session, isLoading: isSessionLoading, error: sessionError } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });

  useEffect(() => {
    if (session) {
      clearCloudSignInAttempt();
      navigate(nextPath, { replace: true });
    }
  }, [session, navigate, nextPath]);

  const mutation = useMutation({
    mutationFn: async () => {
      if (mode === "sign_in" && codeSentTo) {
        await authApi.signInWithCode({ email: codeSentTo, otp: code.trim() });
        return;
      }
      if (mode === "sign_in") {
        await authApi.signInEmail({ email: email.trim(), password });
        return;
      }
      await authApi.signUpEmail({
        name: name.trim(),
        email: email.trim(),
        password,
      });
    },
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
      await queryClient.invalidateQueries({ queryKey: queryKeys.health });
      // Reset rather than invalidate: the `["companies"]` entry is shared app-wide and
      // is not account-scoped, so invalidating leaves the previous account's list
      // readable (and any fetch for that session in flight) until the refetch lands.
      // Sign-in can change accounts, so drop the list outright.
      await queryClient.resetQueries({ queryKey: queryKeys.companies.all });
      navigate(nextPath, { replace: true });
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Authentication failed");
    },
  });

  const sendCodeMutation = useMutation({
    mutationFn: async () => {
      const target = email.trim();
      await authApi.sendSignInCode({ email: target });
      return target;
    },
    onSuccess: (target) => {
      setError(null);
      setCode("");
      setCodeSentTo(target);
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Could not send the sign-in code");
    },
  });

  const emailCodeEnabled = healthQuery.data?.emailCodeSignIn === true;
  const passwordDisabled = emailCodeEnabled && healthQuery.data?.passwordSignInDisabled === true;
  const codeOnly = passwordDisabled && mode === "sign_in";
  const awaitingCode = mode === "sign_in" && codeSentTo !== null;
  const isPending = mutation.isPending || sendCodeMutation.isPending;

  const requestCode = () => {
    if (isPending) return;
    if (email.trim().length === 0) {
      setError("Enter your email to receive a sign-in code.");
      return;
    }
    sendCodeMutation.mutate();
  };

  const canSubmit = awaitingCode
    ? code.trim().length === SIGN_IN_CODE_LENGTH
    : codeOnly
      ? email.trim().length > 0
      : email.trim().length > 0 &&
        password.trim().length > 0 &&
        (mode === "sign_in" || (name.trim().length > 0 && password.trim().length >= 8));

  if (healthQuery.isLoading || isSessionLoading || session) {
    return (
      <div className="fixed inset-0 flex items-center justify-center">
        <PaperclipLoading className="min-h-0" />
      </div>
    );
  }

  // A health/session failure must not be mistaken for a self-hosted instance.
  if (healthQuery.error || sessionError) {
    return <p role="alert" className="p-6 text-sm text-destructive">Unable to check sign-in. Refresh and try again.</p>;
  }

  if (healthQuery.data?.cloud) {
    return <CloudSignIn cloud={healthQuery.data.cloud} returnTo={nextPath} />;
  }

  return (
    <div className="fixed inset-0 flex bg-background">
      <div className="absolute top-4 right-4 z-10">
        <ThemeToggle />
      </div>
      {/* Left half — form */}
      <div className="w-full md:w-1/2 flex flex-col overflow-y-auto">
        <div className="w-full max-w-md mx-auto my-auto px-8 py-12">
          <div className="mb-8">
            <PaperclipLockup className="h-5 w-auto" />
          </div>

          <h1 className="text-xl font-semibold">
            {mode === "sign_in" ? "Sign in to Paperclip" : "Create your Paperclip account"}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {awaitingCode
              ? "Enter the code we emailed you."
              : codeOnly
                ? "Enter your email and we'll send you a sign-in code."
                : mode === "sign_in"
                ? "Use your email and password to access this instance."
                : "Create an account for this instance. Email confirmation is not required in v1."}
          </p>

          {awaitingCode && (
            <p role="status" className="mt-4 rounded-md border border-border px-3 py-2 text-sm">
              If {codeSentTo} has an account, an {SIGN_IN_CODE_LENGTH}-digit code is on its way. It expires in 10 minutes and works once.
            </p>
          )}

          <form
            className="mt-6 space-y-4"
            method="post"
            action={mode === "sign_up" ? "/api/auth/sign-up/email" : "/api/auth/sign-in/email"}
            onSubmit={(event) => {
              event.preventDefault();
              if (isPending) return;
              if (codeOnly && !awaitingCode) {
                requestCode();
                return;
              }
              if (!canSubmit) {
                setError("Please fill in all required fields.");
                return;
              }
              mutation.mutate();
            }}
          >
            {mode === "sign_up" && (
              <div>
                <label htmlFor="name" className="text-xs text-muted-foreground mb-1 block">Name</label>
                <input
                  id="name"
                  name="name"
                  className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  autoComplete="name"
                  required
                  aria-required="true"
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? errorId : undefined}
                  autoFocus
                />
              </div>
            )}
            <div>
              <label htmlFor="email" className="text-xs text-muted-foreground mb-1 block">Email</label>
              <input
                id="email"
                name="email"
                className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="username"
                readOnly={awaitingCode}
                required
                aria-required="true"
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? errorId : undefined}
                autoFocus={mode === "sign_in"}
              />
            </div>
            {awaitingCode && (
              <div>
                <label htmlFor="code" className="text-xs text-muted-foreground mb-1 block">Sign-in code</label>
                <input
                  id="code"
                  name="code"
                  className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm tracking-widest outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                  value={code}
                  onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, SIGN_IN_CODE_LENGTH))}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={SIGN_IN_CODE_LENGTH}
                  required
                  aria-required="true"
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? errorId : undefined}
                  autoFocus
                />
              </div>
            )}
            {!codeOnly && !awaitingCode && (
            <div>
              <label htmlFor="password" className="text-xs text-muted-foreground mb-1 block">Password</label>
              <input
                id="password"
                name="password"
                className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete={mode === "sign_in" ? "current-password" : "new-password"}
                required
                aria-required="true"
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? errorId : undefined}
              />
            </div>
            )}
            {error && (
              <p id={errorId} role="alert" className="text-xs text-destructive">
                {error}
              </p>
            )}
            <Button
              type="submit"
              disabled={isPending}
              aria-disabled={!canSubmit || isPending}
              className={`w-full ${!canSubmit && !isPending ? "opacity-50" : ""}`}
            >
              {isPending
                ? "Working…"
                : awaitingCode
                  ? "Sign in with code"
                  : codeOnly
                    ? "Email me a sign-in code"
                    : mode === "sign_in"
                      ? "Sign In"
                      : "Create Account"}
            </Button>
            {emailCodeEnabled && mode === "sign_in" && (awaitingCode || !passwordDisabled) && (
              <Button
                type="button"
                variant="outline"
                disabled={isPending}
                className="w-full"
                onClick={requestCode}
              >
                {awaitingCode ? "Send a new code" : "Email me a sign-in code"}
              </Button>
            )}
            {awaitingCode && (
              <button
                type="button"
                className="text-xs text-muted-foreground underline underline-offset-2"
                onClick={() => {
                  setError(null);
                  setCode("");
                  setCodeSentTo(null);
                }}
              >
                Use a different email
              </button>
            )}
          </form>

          <div className={`mt-5 text-sm text-muted-foreground ${passwordDisabled ? "hidden" : ""}`}>
            {mode === "sign_in" ? "Need an account?" : "Already have an account?"}{" "}
            <button
              type="button"
              className="font-medium text-foreground underline underline-offset-2"
              onClick={() => {
                setError(null);
                setMode(mode === "sign_in" ? "sign_up" : "sign_in");
              }}
            >
              {mode === "sign_in" ? "Create one" : "Sign in"}
            </button>
          </div>
        </div>
      </div>

      {/* Right half — ASCII art animation (hidden on mobile) */}
      <div className="hidden md:block w-1/2 overflow-hidden">
        <AsciiArtAnimation />
      </div>
    </div>
  );
}
