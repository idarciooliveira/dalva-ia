import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AuthErrorAlert } from "@/components/auth-error-alert";
import { AuthPageLayout } from "@/components/auth/auth-page-layout";
import { GoogleOAuthButton } from "@/components/auth/google-oauth-button";
import { OrDivider } from "@/components/auth/or-divider";
import { authClient, resetUserCache } from "@/lib/auth-client";
import { authErrorMessage } from "@/lib/auth-errors";
import { useSession } from "@/hooks/use-session";

export const Route = createFileRoute("/register")({
  component: RegisterPage,
});

/* -------------------------------------------------------------------------- */
/*  Schema                                                                    */
/* -------------------------------------------------------------------------- */

const registerSchema = z.object({
  name: z.string().min(1, "Please enter your name"),
  email: z.string().email("Please enter a valid email address"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

type RegisterValues = z.infer<typeof registerSchema>;

/* -------------------------------------------------------------------------- */
/*  Page                                                                      */
/* -------------------------------------------------------------------------- */

function RegisterPage() {
  const queryClient = useQueryClient();
  const { data: session } = useSession();
  const isAuthenticated = session != null;
  const router = useRouter();
  const [authError, setAuthError] = useState<string | null>(null);

  // Navigate to onboarding reactively once the auth handshake completes.
  useEffect(() => {
    if (isAuthenticated) {
      router.navigate({ to: "/onboarding" });
    }
  }, [isAuthenticated, router]);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<RegisterValues>({
    resolver: zodResolver(registerSchema),
  });

  async function onSubmit(data: RegisterValues) {
    setAuthError(null);
    try {
      // Signs the new user in too (autoSignIn on the server).
      const { error } = await authClient.signUp.email({
        name: data.name.trim(),
        email: data.email,
        password: data.password,
      });
      if (error) {
        setAuthError(authErrorMessage(error, "signUp"));
        return;
      }
      // The effect above navigates once the new session is read.
      await resetUserCache(queryClient);
    } catch (error) {
      setAuthError(authErrorMessage(error, "signUp"));
    }
  }

  return (
    <AuthPageLayout
      title="Create your account"
      subtitle={
        <>
          Already have an account?{" "}
          <Link
            to="/login"
            className="font-medium text-primary underline-offset-4 hover:underline dark:text-primary"
          >
            Log in
          </Link>
        </>
      }
      footer={
        <p className="mt-6 text-center text-xs leading-relaxed text-muted-foreground">
          By creating an account, you agree to our{" "}
          <a
            href="#"
            className="underline underline-offset-4 hover:text-foreground"
          >
            Terms of Service
          </a>{" "}
          and{" "}
          <a
            href="#"
            className="underline underline-offset-4 hover:text-foreground"
          >
            Privacy Policy
          </a>
          .
        </p>
      }
    >
      {/* Form */}
      <form
        onSubmit={handleSubmit(onSubmit)}
        className="mt-8 space-y-5"
        noValidate
      >
        {/* Auth error */}
        <AuthErrorAlert
          message={authError}
          onDismiss={() => setAuthError(null)}
        />
        {/* Name */}
        <div className="space-y-2">
          <Label htmlFor="name">Name</Label>
          <Input
            id="name"
            type="text"
            placeholder="Your full name"
            autoComplete="name"
            aria-invalid={!!errors.name}
            aria-describedby={errors.name ? "name-error" : undefined}
            className="h-12 rounded-xl px-4"
            {...register("name")}
          />
          {errors.name && (
            <p id="name-error" className="text-sm text-destructive">
              {errors.name.message}
            </p>
          )}
        </div>

        {/* Email */}
        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            placeholder="you@example.com"
            autoComplete="email"
            aria-invalid={!!errors.email}
            aria-describedby={errors.email ? "email-error" : undefined}
            className="h-12 rounded-xl px-4"
            {...register("email")}
          />
          {errors.email && (
            <p id="email-error" className="text-sm text-destructive">
              {errors.email.message}
            </p>
          )}
        </div>

        {/* Password */}
        <div className="space-y-2">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            type="password"
            placeholder="At least 8 characters"
            autoComplete="new-password"
            aria-invalid={!!errors.password}
            aria-describedby={errors.password ? "password-error" : undefined}
            className="h-12 rounded-xl px-4"
            {...register("password")}
          />
          {errors.password && (
            <p id="password-error" className="text-sm text-destructive">
              {errors.password.message}
            </p>
          )}
        </div>

        {/* Submit */}
        <Button
          type="submit"
          variant="accent"
          className="w-full"
          disabled={isSubmitting}
        >
          {isSubmitting ? "Creating account..." : "Create account"}
        </Button>
      </form>

      {/* Divider + Google OAuth */}
      <OrDivider />
      <GoogleOAuthButton />
    </AuthPageLayout>
  );
}
