// Screenpipe Enterprise Edition
// Licensed under the Screenpipe Enterprise License (see ee/LICENSE)

"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

interface LicenseKeyInputProps {
  onActivate: (key: string) => Promise<boolean>;
  error: string | null;
  isLoading: boolean;
}

export function LicenseKeyInput({ onActivate, error, isLoading }: LicenseKeyInputProps) {
  const [key, setKey] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!key.trim()) return;
    await onActivate(key.trim());
  };

  return (
    <div className="flex items-center justify-center min-h-screen">
      <div className="w-full max-w-md p-8 space-y-6">
        <div className="text-center space-y-2">
          <h1 className="text-2xl font-bold">screenpipe enterprise</h1>
          <p className="text-sm text-muted-foreground">
            enter your license key to continue
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            type="text"
            placeholder="XXXX-XXXX-XXXX-XXXX"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            disabled={isLoading}
            autoFocus
          />

          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}

          <Button type="submit" className="w-full" disabled={isLoading || !key.trim()}>
            {isLoading ? "validating..." : "activate"}
          </Button>
        </form>

        <p className="text-xs text-center text-muted-foreground">
          contact your IT administrator if you don&apos;t have a license key
        </p>
      </div>
    </div>
  );
}
