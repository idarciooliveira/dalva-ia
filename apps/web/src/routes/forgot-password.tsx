import { createFileRoute, Link } from "@tanstack/react-router";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { ArrowLeft } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AuthPageLayout } from "@/components/auth/auth-page-layout";

export const Route = createFileRoute("/forgot-password")({
  component: ForgotPasswordPage,
});

/* -------------------------------------------------------------------------- */
/*  Schema                                                                    */
/* -------------------------------------------------------------------------- */

const forgotSchema = z.object({
  email: z.string().email("Please enter a valid email address"),
});

type ForgotValues = z.infer<typeof forgotSchema>;

/* -------------------------------------------------------------------------- */
/*  Page                                                                      */
/* -------------------------------------------------------------------------- */

function ForgotPasswordPage() {
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ForgotValues>({
    resolver: zodResolver(forgotSchema),
  });

  function onSubmit(data: ForgotValues) {
    // TODO: wire to Better Auth password reset
    console.log("Reset password for:", data.email);
  }

  return (
    <AuthPageLayout
      title="Reset your password"
      subtitle="Enter the email associated with your account and we'll send you a reset link."
    >
      {/* Form */}
      <form
        onSubmit={handleSubmit(onSubmit)}
        className="mt-8 space-y-5"
        noValidate
      >
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

        {/* Submit */}
        <Button
          type="submit"
          variant="accent"
          className="w-full"
          disabled={isSubmitting}
        >
          {isSubmitting ? "Sending..." : "Send reset link"}
        </Button>
      </form>

      {/* Back to login */}
      <div className="mt-6 text-center">
        <Link
          to="/login"
          className="inline-flex items-center gap-2 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          <ArrowLeft className="size-3.5" />
          Back to login
        </Link>
      </div>
    </AuthPageLayout>
  );
}
