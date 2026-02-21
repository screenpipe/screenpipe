"use client";

import React, { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import {
  Cloud,
  CloudOff,
  RefreshCw,
  Laptop,
  Trash2,
  Lock,
  Unlock,
  HardDrive,
  Shield,
  Zap,
  Smartphone,
  CheckCircle2,
  AlertCircle,
  Loader2,
  ArrowRight,
  Sparkles,
} from "lucide-react";
import { toast } from "@/components/ui/use-toast";
import { invoke } from "@tauri-apps/api/core";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { useSettings } from "@/lib/hooks/use-settings";
import { motion } from "framer-motion";
import Lottie from "lottie-react";
import cloudSyncAnimation from "@/public/animations/cloud-sync.json";

interface SyncStatus {
  enabled: boolean;
  isSyncing: boolean;
  lastSync: string | null;
  lastError: string | null;
  storageUsed: number | null;
  storageLimit: number | null;
  deviceCount: number | null;
  deviceLimit: number | null;
  syncTier: string | null;
}

interface SyncDevice {
  id: string;
  deviceId: string;
  deviceName: string | null;
  deviceOs: string;
  lastSyncAt: string | null;
  createdAt: string;
  isCurrent: boolean;
}

interface SyncConfig {
  enabled: boolean;
  syncIntervalMinutes: number;
  syncTranscripts: boolean;
  syncOcr: boolean;
  syncAudio: boolean;
  syncFrames: boolean;
}

interface SubscriptionStatus {
  hasSubscription: boolean;
  tier: string | null;
  status: string | null;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

function formatRelativeTime(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${diffDays}d ago`;
}

// Cloud animation component using Lottie
function CloudSyncAnimation() {
  return (
    <div className="w-72 h-40 mx-auto">
      <Lottie
        animationData={cloudSyncAnimation}
        loop={true}
        autoplay={true}
        style={{ width: "100%", height: "100%" }}
      />
    </div>
  );
}

// Benefits section
function SyncBenefits() {
  const benefits = [
    {
      icon: <Shield className="w-5 h-5" />,
      title: "Zero-Knowledge Encryption",
      description: "Your data is encrypted before it leaves your device. We can never see your data.",
    },
    {
      icon: <Smartphone className="w-5 h-5" />,
      title: "Access Anywhere",
      description: "Search and access your memory from any device.",
    },
    {
      icon: <Zap className="w-5 h-5" />,
      title: "Automatic Backup",
      description: "Never lose your data. Continuous sync keeps everything safe.",
    },
  ];

  return (
    <div className="grid gap-4 mt-6">
      {benefits.map((benefit, i) => (
        <motion.div
          key={i}
          initial={{ opacity: 0, x: -20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: i * 0.1 }}
          className="flex items-start gap-3"
        >
          <div className="p-2 rounded-lg bg-primary/10 text-primary">
            {benefit.icon}
          </div>
          <div>
            <h4 className="text-sm font-medium">{benefit.title}</h4>
            <p className="text-xs text-muted-foreground">{benefit.description}</p>
          </div>
        </motion.div>
      ))}
    </div>
  );
}

// Onboarding/upgrade prompt
function SyncOnboarding({ onSubscribe, onRefresh, isLoading, isRefreshing, isLoggedIn }: { onSubscribe: (isAnnual: boolean) => void; onRefresh: () => void; isLoading: boolean; isRefreshing: boolean; isLoggedIn: boolean }) {
  const [isAnnual, setIsAnnual] = useState(true);

  return (
    <div className="space-y-6">
      <div className="text-center">
        <CloudSyncAnimation />
        <h3 className="text-xl font-semibold mt-4">Cloud Sync</h3>
        <p className="text-sm text-muted-foreground mt-2">
          Sync your Screenpipe data across all your devices with end-to-end encryption
        </p>
      </div>

      <SyncBenefits />

      <Card className="p-4 bg-primary/5 border-primary/20">
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-primary" />
              <span className="font-medium">Screenpipe Pro</span>
            </div>
            <p className="text-sm text-muted-foreground mt-1">
              50GB storage · 3 devices · Priority support
            </p>
          </div>
          <div className="text-right">
            <div className="text-lg font-bold">
              ${isAnnual ? "49" : "99"}
              <span className="text-sm font-normal text-muted-foreground">
                /mo
              </span>
            </div>
            {isAnnual && (
              <p className="text-xs text-primary">$588/year - Save 50%</p>
            )}
          </div>
        </div>

        {/* Billing toggle */}
        <div className="flex items-center justify-center gap-3 mt-4">
          <span className={`text-sm ${!isAnnual ? "text-foreground" : "text-muted-foreground"}`}>
            Monthly
          </span>
          <Switch
            checked={isAnnual}
            onCheckedChange={setIsAnnual}
          />
          <span className={`text-sm ${isAnnual ? "text-foreground" : "text-muted-foreground"}`}>
            Annual
          </span>
        </div>

        {isLoggedIn ? (
          <Button
            className="w-full mt-4"
            onClick={() => onSubscribe(isAnnual)}
            disabled={isLoading}
          >
            {isLoading ? (
              <Loader2 className="w-4 h-4 animate-spin mr-2" />
            ) : null}
            Get Cloud Sync
            <ArrowRight className="w-4 h-4 ml-2" />
          </Button>
        ) : (
          <div className="mt-4 space-y-2">
            <p className="text-sm text-center text-muted-foreground">
              Please log in to subscribe
            </p>
            <Button
              className="w-full"
              variant="outline"
              onClick={async () => {
                const { open } = await import("@tauri-apps/plugin-shell");
                await open("https://screenpi.pe/login");
              }}
            >
              Log in to continue
              <ArrowRight className="w-4 h-4 ml-2" />
            </Button>
          </div>
        )}
        <a
          href="https://docs.screenpi.pe/cloud-sync"
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-center text-muted-foreground mt-3 block hover:text-primary underline"
        >
          Learn how encryption works →
        </a>
      </Card>

      <Button
        variant="ghost"
        size="sm"
        onClick={onRefresh}
        disabled={isRefreshing}
        className="mx-auto flex items-center gap-2 text-muted-foreground"
      >
        <RefreshCw className={`w-3 h-3 ${isRefreshing ? "animate-spin" : ""}`} />
        {isRefreshing ? "Checking..." : "Already subscribed? Refresh"}
      </Button>
    </div>
  );
}

// Password setup step
function PasswordSetup({ onSubmit, isLoading }: { onSubmit: (password: string) => void; isLoading: boolean }) {
  const [password, setPassword] = useState("");

  const handleSubmit = () => {
    if (password.length < 8) {
      toast({
        title: "Password too short",
        description: "Password must be at least 8 characters",
        variant: "destructive",
      });
      return;
    }
    onSubmit(password);
  };

  return (
    <div className="space-y-6">
      <div className="text-center">
        <CloudSyncAnimation />
        <h3 className="text-xl font-semibold mt-4">Enter Your Encryption Password</h3>
        <p className="text-sm text-muted-foreground mt-2">
          Enter the password you use for Cloud Sync.
          If this is your first device, create a new password.
        </p>
      </div>

      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="password">Encryption Password</Label>
          <Input
            id="password"
            type="password"
            placeholder="Enter your encryption password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSubmit();
            }}
          />
        </div>
      </div>

      <Card className="p-3 border-muted">
        <div className="flex gap-2">
          <AlertCircle className="w-4 h-4 text-muted-foreground flex-shrink-0 mt-0.5" />
          <p className="text-xs text-muted-foreground">
            <strong>Important:</strong> If you forget this password, your cloud data cannot be recovered.
            Consider using a password manager.
          </p>
        </div>
      </Card>

      <Button
        className="w-full"
        onClick={handleSubmit}
        disabled={isLoading || !password}
      >
        {isLoading ? (
          <Loader2 className="w-4 h-4 animate-spin mr-2" />
        ) : (
          <Unlock className="w-4 h-4 mr-2" />
        )}
        {isLoading ? "Setting up..." : "Enable Cloud Sync"}
      </Button>
    </div>
  );
}

// Main sync settings (shown when subscribed and initialized)
function ActiveSyncSettings({
  status,
  devices,
  onToggleSync,
  onTriggerSync,
  onRemoveDevice,
  onDeleteCloudData,
  isSyncing,
}: {
  status: SyncStatus;
  devices: SyncDevice[];
  onToggleSync: (enabled: boolean) => void;
  onTriggerSync: () => void;
  onRemoveDevice: (deviceId: string) => void;
  onDeleteCloudData: () => void;
  isSyncing: boolean;
}) {
  const storagePercent =
    status?.storageUsed && status?.storageLimit
      ? (status.storageUsed / status.storageLimit) * 100
      : 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {status?.enabled ? (
            <Cloud className="h-5 w-5 text-primary" />
          ) : (
            <CloudOff className="h-5 w-5 text-muted-foreground" />
          )}
          <div>
            <h3 className="text-lg font-medium">Cloud Sync</h3>
            <p className="text-sm text-muted-foreground">
              Sync your data across devices with end-to-end encryption
            </p>
          </div>
        </div>
        <Switch
          checked={status?.enabled ?? false}
          onCheckedChange={onToggleSync}
        />
      </div>

      {status?.enabled && (
        <>
          <Separator />

          {/* Status Card */}
          <Card className="p-4 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                {status.isSyncing || isSyncing ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin text-primary" />
                    <span className="text-sm">Syncing your data...</span>
                  </>
                ) : status.lastError ? (
                  <>
                    <AlertCircle className="h-4 w-4 text-destructive" />
                    <span className="text-sm text-destructive">
                      {status.lastError}
                    </span>
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="h-4 w-4 text-foreground" />
                    <span className="text-sm text-muted-foreground">
                      {status.lastSync
                        ? `Last synced ${formatRelativeTime(status.lastSync)}`
                        : "Ready to sync"}
                    </span>
                  </>
                )}
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={onTriggerSync}
                disabled={isSyncing || status.isSyncing}
              >
                <RefreshCw
                  className={`h-4 w-4 mr-2 ${
                    isSyncing || status.isSyncing ? "animate-spin" : ""
                  }`}
                />
                Sync Now
              </Button>
            </div>

            {/* Storage Usage */}
            {status.storageLimit && (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <div className="flex items-center gap-2">
                    <HardDrive className="h-4 w-4 text-muted-foreground" />
                    <span>storage</span>
                  </div>
                  <span className="text-muted-foreground">
                    {formatBytes(status.storageUsed ?? 0)} /{" "}
                    {formatBytes(status.storageLimit)}
                  </span>
                </div>
                <Progress value={storagePercent} className="h-2" />
              </div>
            )}

            {/* Tier Badge */}
            {status.syncTier && (
              <div className="flex items-center gap-2">
                <Badge variant="secondary">{status.syncTier}</Badge>
                <span className="text-sm text-muted-foreground">
                  {status.deviceCount}/{status.deviceLimit} devices
                </span>
              </div>
            )}
          </Card>

          {/* What's synced */}
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              Everything syncs automatically in the background. Screen recordings, audio, and transcriptions.
              Uses ~0.8 GB per monitor per day.
            </p>
            <a
              href="https://docs.screenpi.pe/cloud-sync"
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-muted-foreground hover:text-primary underline"
            >
              Learn how encryption works →
            </a>
          </div>


          {/* Devices */}
          <Separator />
          <div className="space-y-4">
            <h4 className="text-sm font-medium">Your Devices</h4>
            {devices.length > 0 ? (
              <div className="space-y-2">
                {devices.map((device) => (
                  <Card
                    key={device.deviceId}
                    className="p-3 flex items-center justify-between"
                  >
                    <div className="flex items-center gap-3">
                      <Laptop className="h-4 w-4 text-muted-foreground" />
                      <div>
                        <p className="text-sm font-medium">
                          {device.deviceName || device.deviceId}
                          {device.isCurrent && (
                            <Badge variant="outline" className="ml-2 text-xs">
                              This device
                            </Badge>
                          )}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {device.deviceOs}
                          {device.lastSyncAt &&
                            ` - last synced ${formatRelativeTime(device.lastSyncAt)}`}
                        </p>
                      </div>
                    </div>
                    {!device.isCurrent && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => onRemoveDevice(device.deviceId)}
                      >
                        <Trash2 className="h-4 w-4 text-muted-foreground" />
                      </Button>
                    )}
                  </Card>
                ))}
              </div>
            ) : (
              <Card className="p-4 border-dashed">
                <div className="text-center text-sm text-muted-foreground">
                  <Laptop className="h-8 w-8 mx-auto mb-2 opacity-50" />
                  <p>This is your first synced device</p>
                  <p className="text-xs mt-1">
                    Install Screenpipe on another device and log in with the same account to see it here
                  </p>
                </div>
              </Card>
            )}
          </div>

          {/* Danger Zone */}
          <Separator />
          <div className="space-y-4">
            <h4 className="text-sm font-medium">Danger Zone</h4>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" size="sm">
                  <Trash2 className="h-4 w-4 mr-2" />
                  Delete Cloud Data
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete All Cloud Data?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This will permanently delete all your synced data from the
                    cloud. This action cannot be undone. Your local data will
                    not be affected.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={onDeleteCloudData}
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  >
                    Delete Forever
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </>
      )}
    </div>
  );
}

export function SyncSettings() {
  const { settings, isSettingsLoaded, updateSettings } = useSettings();
  const [step, setStep] = useState<"loading" | "onboarding" | "password" | "active">("loading");
  const [subscription, setSubscription] = useState<SubscriptionStatus | null>(null);
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [devices, setDevices] = useState<SyncDevice[]>([]);
  const [config, setConfig] = useState<SyncConfig | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);

  useEffect(() => {
    if (isSettingsLoaded) {
      checkSubscriptionAndLoad();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSettingsLoaded]);

  // Auto-poll for subscription when on onboarding step
  useEffect(() => {
    if (step !== "onboarding") return;

    const pollInterval = setInterval(async () => {
      console.log("auto-polling for subscription...");
      const hasSubscription = await checkSubscriptionAndLoad();
      if (hasSubscription) {
        clearInterval(pollInterval);
        toast({
          title: "subscription detected",
          description: "you can now set up your encryption password",
        });
      }
    }, 1000); // Poll every 1 second

    return () => clearInterval(pollInterval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const tryAutoInitSync = async (): Promise<boolean> => {
    // 1. Check if the server-side sync service is already running (same session, navigated away and back)
    try {
      const serverStatus = await fetch("http://localhost:3030/sync/status");
      if (serverStatus.ok) {
        const serverData = await serverStatus.json();
        if (serverData.enabled) {
          await invoke("set_sync_enabled", { enabled: true });
          return true;
        }
      }
    } catch {
      // Server not reachable
    }

    // 2. Try to auto-init from saved password (app restart case)
    try {
      const savedPassword = localStorage.getItem("sync_password");
      if (savedPassword) {
        const password = atob(savedPassword);
        await invoke<boolean>("init_sync", { password });
        return true;
      }
    } catch (e) {
      console.log("auto-init sync failed, will prompt for password:", e);
      localStorage.removeItem("sync_password");
    }

    return false;
  };

  const checkSubscriptionAndLoad = async (): Promise<boolean> => {
    try {
      const token = settings.user?.token;
      const userId = settings.user?.id;

      if (!token || !userId) {
        console.log("no token or userId, showing onboarding");
        setStep("onboarding");
        return false;
      }

      const email = settings.user?.email || "";
      const response = await fetch(`https://screenpi.pe/api/cloud-sync/subscription?userId=${userId}&email=${encodeURIComponent(email)}`, {
        headers: {
          "Authorization": `Bearer ${token}`,
        },
      });

      if (response.ok) {
        const data = await response.json();
        console.log("cloud sync subscription check:", data);
        setSubscription({
          hasSubscription: data.hasSubscription,
          tier: data.subscription?.tier || null,
          status: data.subscription?.status || null,
        });

        if (data.hasSubscription) {
          // Update user.cloud_subscribed so account-section shows correct state
          if (settings.user && !settings.user.cloud_subscribed) {
            await updateSettings({
              user: { ...settings.user, cloud_subscribed: true },
            });
          }
          try {
            const [statusResult, configResult, devicesResult] = await Promise.all([
              invoke<SyncStatus>("get_sync_status"),
              invoke<SyncConfig>("get_sync_config"),
              invoke<SyncDevice[]>("get_sync_devices"),
            ]);
            setStatus(statusResult);
            setConfig(configResult);
            setDevices(devicesResult);

            if (statusResult.enabled) {
              setStep("active");
            } else {
              // Try to auto-init from saved password or running server
              const autoInited = await tryAutoInitSync();
              if (autoInited) {
                // Re-fetch status after auto-init
                const [newStatus, newConfig, newDevices] = await Promise.all([
                  invoke<SyncStatus>("get_sync_status"),
                  invoke<SyncConfig>("get_sync_config"),
                  invoke<SyncDevice[]>("get_sync_devices"),
                ]);
                setStatus(newStatus);
                setConfig(newConfig);
                setDevices(newDevices);
                setStep("active");
              } else {
                setStep("password");
              }
            }
          } catch (backendError) {
            console.error("sync backend not ready:", backendError);
            setStep("password");
          }
          return true;
        } else {
          setStep("onboarding");
          return false;
        }
      } else {
        console.log("subscription API returned non-ok status:", response.status);
        setStep("onboarding");
        return false;
      }
    } catch (error) {
      console.error("failed to check subscription:", error);
      setStep("onboarding");
      return false;
    }
  };

  const handleSubscribe = async (isAnnual: boolean = true) => {
    try {
      setIsLoading(true);
      const token = settings.user?.token;
      const userId = settings.user?.id;

      if (!token || !userId) {
        toast({
          title: "please log in first",
          description: "you need to be logged in to subscribe",
          variant: "destructive",
        });
        return;
      }

      const response = await fetch("https://screenpi.pe/api/cloud-sync/checkout", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify({
          tier: "pro",
          billingPeriod: isAnnual ? "yearly" : "monthly",
          userId,
          email: settings.user?.email,
        }),
      });

      const data = await response.json();

      if (data.url) {
        const { open } = await import("@tauri-apps/plugin-shell");
        await open(data.url);

        toast({
          title: "checkout opened",
          description: "complete your purchase in the browser, then return here",
        });

        // Poll for subscription status - stop when subscription is detected
        let pollCount = 0;
        const maxPolls = 300; // 5 minutes at 1 second intervals
        const checkInterval = setInterval(async () => {
          pollCount++;
          console.log(`polling for subscription... attempt ${pollCount}`);
          const hasSubscription = await checkSubscriptionAndLoad();
          if (hasSubscription) {
            console.log("subscription detected, stopping poll");
            clearInterval(checkInterval);
            toast({
              title: "subscription activated",
              description: "you can now set up your encryption password",
            });
          } else if (pollCount >= maxPolls) {
            console.log("stopping subscription poll - max attempts reached");
            clearInterval(checkInterval);
          }
        }, 1000);
      } else {
        throw new Error(data.error || "failed to create checkout");
      }
    } catch (error) {
      toast({
        title: "failed to start checkout",
        description: String(error),
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handlePasswordSubmit = async (password: string) => {
    try {
      setIsLoading(true);
      await invoke<boolean>("init_sync", { password });

      // Remember password for auto-init on next app launch
      // Stored in app's WebView localStorage (sandboxed, not accessible externally)
      try {
        localStorage.setItem("sync_password", btoa(password));
      } catch {
        // Non-critical if storage fails
      }

      toast({
        title: "cloud sync enabled",
        description: "your data is now syncing securely",
      });

      await checkSubscriptionAndLoad();
      setStep("active");
    } catch (error) {
      toast({
        title: "failed to initialize sync",
        description: String(error),
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleToggleSync = async (enabled: boolean) => {
    try {
      await invoke("set_sync_enabled", { enabled });
      setStatus((prev) => (prev ? { ...prev, enabled } : null));
      toast({
        title: enabled ? "sync enabled" : "sync disabled",
        description: enabled
          ? "your data will now sync to the cloud"
          : "sync has been paused",
      });
    } catch (error) {
      toast({
        title: "failed to update sync",
        description: String(error),
        variant: "destructive",
      });
    }
  };

  const handleTriggerSync = async () => {
    try {
      setIsSyncing(true);
      await invoke("trigger_sync");
      toast({
        title: "sync started",
        description: "syncing your data to the cloud",
      });

      const checkSync = async () => {
        const newStatus = await invoke<SyncStatus>("get_sync_status");
        setStatus(newStatus);
        if (newStatus.isSyncing) {
          setTimeout(checkSync, 1000);
        } else {
          setIsSyncing(false);
          toast({
            title: "sync complete",
            description: "your data has been synced",
          });
        }
      };
      setTimeout(checkSync, 1000);
    } catch (error) {
      setIsSyncing(false);
      toast({
        title: "sync failed",
        description: String(error),
        variant: "destructive",
      });
    }
  };

  const handleUpdateConfig = async (updates: Partial<SyncConfig>) => {
    if (!config) return;

    const newConfig = { ...config, ...updates };
    try {
      await invoke("update_sync_config", { config: newConfig });
      setConfig(newConfig);
    } catch (error) {
      toast({
        title: "failed to update settings",
        description: String(error),
        variant: "destructive",
      });
    }
  };

  const handleRemoveDevice = async (deviceId: string) => {
    try {
      await invoke("remove_sync_device", { deviceId });
      setDevices((prev) => prev.filter((d) => d.deviceId !== deviceId));
      toast({
        title: "device removed",
        description: "the device has been unlinked from your sync",
      });
    } catch (error) {
      toast({
        title: "failed to remove device",
        description: String(error),
        variant: "destructive",
      });
    }
  };

  const handleDeleteCloudData = async () => {
    try {
      await invoke("delete_cloud_data");
      localStorage.removeItem("sync_password");
      toast({
        title: "cloud data deleted",
        description: "all your cloud data has been permanently deleted",
      });
      await checkSubscriptionAndLoad();
    } catch (error) {
      toast({
        title: "failed to delete data",
        description: String(error),
        variant: "destructive",
      });
    }
  };

  const handleLockSync = async () => {
    await invoke("lock_sync");
    localStorage.removeItem("sync_password");
    await checkSubscriptionAndLoad();
  };

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      await checkSubscriptionAndLoad();
    } finally {
      setIsRefreshing(false);
    }
  };

  if (step === "loading") {
    return (
      <div className="flex items-center justify-center p-8">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (step === "onboarding") {
    const isLoggedIn = !!(settings.user?.token && settings.user?.id);
    return <SyncOnboarding onSubscribe={handleSubscribe} onRefresh={handleRefresh} isLoading={isLoading} isRefreshing={isRefreshing} isLoggedIn={isLoggedIn} />;
  }

  if (step === "password") {
    return <PasswordSetup onSubmit={handlePasswordSubmit} isLoading={isLoading} />;
  }

  if (step === "active" && status) {
    return (
      <ActiveSyncSettings
        status={status}
        devices={devices}
        onToggleSync={handleToggleSync}
        onTriggerSync={handleTriggerSync}
        onRemoveDevice={handleRemoveDevice}
        onDeleteCloudData={handleDeleteCloudData}
        isSyncing={isSyncing}
      />
    );
  }

  return null;
}
