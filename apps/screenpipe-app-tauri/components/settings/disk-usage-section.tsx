"use client";

import React from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { Button } from "../ui/button";
import { Separator } from "../ui/separator";
import { Badge } from "../ui/badge";
import { useDiskUsage } from "@/lib/hooks/use-disk-usage";
import { RefreshCw, HardDrive, Folder, Video, Mic, Database, Calculator, FileText } from "lucide-react";
import { Skeleton } from "../ui/skeleton";
import { cn } from "@/lib/utils";
import { Progress } from "../ui/progress";

export function DiskUsageSection() {
  const { diskUsage, isLoading, error, refetch } = useDiskUsage();

  const handleRefresh = () => {
    refetch();
  };

  if (error) {
    return (
      <div className="space-y-6">
        <div>
          <h3 className="text-lg font-medium">Disk Usage</h3>
          <p className="text-sm text-muted-foreground">
            Monitor storage usage for your Screenpipe data
          </p>
        </div>
        <Card>
          <CardContent className="pt-6">
            <div className="text-center text-destructive">
              <p>Failed to load disk usage: {error}</p>
              <Button onClick={handleRefresh} variant="outline" className="mt-2">
                <RefreshCw className="h-4 w-4 mr-2" />
                Retry
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-bold tracking-tight text-foreground">
            Disk Usage
          </h1>
          <Button
            onClick={handleRefresh}
            variant="outline"
            size="sm"
            disabled={isLoading}
            className="h-7 text-xs"
          >
            <RefreshCw className={`h-3 w-3 mr-1.5 ${isLoading ? "animate-spin" : ""}`} />
            {isLoading ? "..." : "Refresh"}
          </Button>
        </div>
        <p className="text-muted-foreground text-sm">
          Storage usage at ~/.screenpipe
        </p>
      </div>

      {isLoading && (
        <div className="flex items-center space-x-2 px-1 text-xs text-muted-foreground">
          <Calculator className="h-3 w-3 animate-pulse" />
          <span>Calculating...</span>
        </div>
      )}

      {/* Memory summary */}
      {!isLoading && diskUsage?.recording_since && (() => {
        const since = new Date(diskUsage.recording_since);
        const months = Math.max(1, Math.round((Date.now() - since.getTime()) / (1000 * 60 * 60 * 24 * 30)));
        const dataGb = (diskUsage.total_data_bytes / (1024 ** 3)).toFixed(1);
        const totalBytes = diskUsage.total_data_bytes + diskUsage.available_space_bytes;
        const usedPct = totalBytes > 0 ? Math.round((diskUsage.total_data_bytes / totalBytes) * 100) : 0;
        const ratePerMonth = diskUsage.total_data_bytes / months;
        const remainingMonths = ratePerMonth > 0 ? Math.round(diskUsage.available_space_bytes / ratePerMonth) : 0;
        return (
          <div className="rounded-md border border-border bg-card px-3 py-2.5 space-y-1.5">
            <p className="text-sm font-medium">
              {months} {months === 1 ? "month" : "months"} of memory in {dataGb} GB
            </p>
            <Progress value={usedPct} className="h-1.5" />
            <p className="text-xs text-muted-foreground">
              ~{remainingMonths} {remainingMonths === 1 ? "month" : "months"} of space remaining
            </p>
          </div>
        );
      })()}

      {/* Overview Cards */}
      <div className="grid grid-cols-3 gap-2">
        <Card className={cn("border-border bg-card", isLoading && "opacity-75")}>
          <CardContent className="px-3 py-2.5">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs text-muted-foreground">Data</span>
              <Database className={cn("h-3 w-3 text-muted-foreground", isLoading && "animate-pulse")} />
            </div>
            {isLoading ? <Skeleton className="h-5 w-16" /> : (
              <div className="text-sm font-bold">{diskUsage?.total_data_size || "0 KB"}</div>
            )}
          </CardContent>
        </Card>

        <Card className={cn("border-border bg-card", isLoading && "opacity-75")}>
          <CardContent className="px-3 py-2.5">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs text-muted-foreground">Cache</span>
              <Folder className={cn("h-3 w-3 text-muted-foreground", isLoading && "animate-pulse")} />
            </div>
            {isLoading ? <Skeleton className="h-5 w-16" /> : (
              <div className="text-sm font-bold">{diskUsage?.total_cache_size || "0 KB"}</div>
            )}
          </CardContent>
        </Card>

        <Card className={cn("border-border bg-card", isLoading && "opacity-75")}>
          <CardContent className="px-3 py-2.5">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs text-muted-foreground">Free</span>
              <HardDrive className={cn("h-3 w-3 text-muted-foreground", isLoading && "animate-pulse")} />
            </div>
            {isLoading ? <Skeleton className="h-5 w-16" /> : (
              <div className="text-sm font-bold">{diskUsage?.available_space || "Unknown"}</div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Media Breakdown */}
      <Card className={cn("border-border bg-card", isLoading && "opacity-75")}>
        <CardContent className="px-3 py-2.5 space-y-2">
          <div className="flex items-center space-x-2.5">
            <Video className={cn("h-4 w-4 text-muted-foreground shrink-0", isLoading && "animate-pulse")} />
            <h3 className="text-sm font-medium text-foreground">Media Files</h3>
          </div>
          {isLoading ? (
            <div className="space-y-1.5 ml-[26px]"><Skeleton className="h-4 w-32" /><Skeleton className="h-4 w-28" /></div>
          ) : (
            <div className="space-y-1.5 ml-[26px]">
              {diskUsage?.media.monitors && diskUsage.media.monitors.length > 0 && (() => {
                const since = diskUsage?.recording_since ? new Date(diskUsage.recording_since) : null;
                const months = since ? Math.max(1, (Date.now() - since.getTime()) / (1000 * 60 * 60 * 24 * 30)) : null;
                return diskUsage.media.monitors.map((m) => (
                  <div key={m.name} className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground truncate mr-2">{m.name}</span>
                    <span className="font-medium shrink-0">
                      {m.size}
                      {months && (
                        <span className="text-muted-foreground font-normal ml-1">
                          (~{(m.size_bytes / months / (1024 ** 3)).toFixed(1)} GB/mo)
                        </span>
                      )}
                    </span>
                  </div>
                ));
              })()}
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">Audio</span>
                <span className="font-medium">{diskUsage?.media.audios_size || "0 KB"}</span>
              </div>
              <div className="flex items-center justify-between text-xs pt-1 border-t">
                <span className="font-medium">Total</span>
                <span className="font-bold">{diskUsage?.media.total_media_size || "0 KB"}</span>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Other Files */}
      <Card className={cn("border-border bg-card", isLoading && "opacity-75")}>
        <CardContent className="px-3 py-2.5 space-y-2">
          <div className="flex items-center space-x-2.5">
            <FileText className={cn("h-4 w-4 text-muted-foreground shrink-0", isLoading && "animate-pulse")} />
            <h3 className="text-sm font-medium text-foreground">Other Files</h3>
          </div>
          {isLoading ? (
            <div className="space-y-1.5 ml-[26px]"><Skeleton className="h-4 w-28" /><Skeleton className="h-4 w-24" /></div>
          ) : (
            <div className="space-y-1.5 ml-[26px]">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">Database</span>
                <span className="font-medium">{diskUsage?.other?.database_size || "0 KB"}</span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">Logs</span>
                <span className={cn("font-medium", diskUsage?.other?.logs_size?.includes("GB") && "text-destructive")}>{diskUsage?.other?.logs_size || "0 KB"}</span>
              </div>
              {diskUsage?.other?.logs_size?.includes("GB") && (
                <p className="text-[11px] text-destructive mt-1">⚠️ Logs are large. Delete old ones at ~/.screenpipe/*.log</p>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
} 