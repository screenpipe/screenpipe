import { Message } from "ai";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { useState, useEffect, useRef } from "react";
import { emit } from "@tauri-apps/api/event";

import { cn } from "@/lib/utils";
import { useTimelineStore } from "@/lib/hooks/use-timeline-store";
import { CodeBlock } from "@/components/ui/codeblock";
import { MemoizedReactMarkdown } from "@/components/markdown";
import {
	IconOpenAI,
	IconUser,
	IconClaude,
	IconGemini,
} from "@/components/rewind/ui/icons";
import { ChatMessageActions } from "@/components/rewind/chat-message-actions";
import { useSettings } from "@/lib/hooks/use-settings";
import { VideoComponent } from "./video";
import { MermaidDiagram } from "./mermaid-diagram";
import { ChevronDown } from "lucide-react";
import { commands } from "@/lib/utils/tauri";
import { toast } from "@/components/ui/use-toast";

export interface ChatMessageProps {
	message: Message;
}

export function ChatMessage({ message, ...props }: ChatMessageProps) {
	const { settings } = useSettings();
	const setPendingNavigation = useTimelineStore((s) => s.setPendingNavigation);
	const [isThinking, setIsThinking] = useState(false);
	const [thinkingContent, setThinkingContent] = useState<string[]>([]);
	const [thinkingTime, setThinkingTime] = useState(0);
	const [isExpanded, setIsExpanded] = useState(false);
	const timerRef = useRef<NodeJS.Timeout | null>(null);

	useEffect(() => {
		if (!message?.content) return;

		const openTag = /<think>/g.test(message.content);
		const closeTag = /<\/think>/g.test(message.content);

		const matches = message.content.match(/<think>([\s\S]*?)(?:<\/think>|$)/g);
		if (matches) {
			const contents = matches.map((match) =>
				match.replace(/<think>|<\/think>/g, "").trim(),
			);
			setThinkingContent(contents);
		}

		if (openTag && !closeTag) {
			setIsThinking(true);
		} else if (openTag && closeTag) {
			setIsThinking(true);
			clearTimeout(timerRef.current ?? undefined);
		} else {
			setIsThinking(false);
			setThinkingContent([]);
			setThinkingTime(0);
		}
	}, [message.content]);

	useEffect(() => {
		if (isThinking) {
			timerRef.current = setInterval(() => {
				setThinkingTime((prev) => prev + 1);
			}, 1000);
		}
		return () => {
			clearInterval(timerRef.current ?? undefined);
		};
	}, [isThinking]);

	const processThinkContent = (content: string) => {
		return content.replace(/<think>[\s\S]*?(<\/think>|$)/g, "").trim();
	};

	const hasMP4File = (content: string) =>
		content.trim().toLowerCase().includes(".mp4");

	if (!message?.content?.trim()) {
		return null;
	}

	const activePreset = settings.aiPresets.find((p) => p.defaultPreset);

	return (
		<div
			className={cn("group relative mb-4 flex items-start w-full")}
			{...props}
		>
			<div
				className={cn(
					"flex size-8 shrink-0 select-none items-center justify-center rounded-md border shadow",
					message.role === "user"
						? "bg-background"
						: "bg-primary text-primary-foreground",
				)}
			>
				{message.role === "user" ? (
					<IconUser />
				) : activePreset?.model?.includes("gpt") ? (
					<IconOpenAI />
				) : activePreset?.model?.includes("claude") ? (
					<IconClaude />
				) : activePreset?.model?.includes("gemini") ? (
					<IconGemini />
				) : (
					<>🦙</>
				)}
			</div>
			<div className="flex-1 px-1 ml-4 space-y-2 overflow-hidden min-w-0">
				{isThinking && thinkingContent.length > 0 && (
					<div
						className={cn(
							"my-2 rounded-lg border transition-all duration-300",
							"bg-muted/50 border-muted-foreground/20 text-muted-foreground",
						)}
					>
						<button
							onClick={() => setIsExpanded(!isExpanded)}
							className="w-full p-3 flex items-center gap-2 hover:bg-muted/70 transition-colors"
						>
							<span className="animate-pulse">💭</span>
							<span className="text-sm text-muted-foreground flex-1 text-left">
								{isThinking
									? `Thinking... (${thinkingTime}s)`
									: `Thought for ${thinkingTime}s`}
							</span>
							<span
								className={cn(
									"transform transition-transform duration-200",
									isExpanded ? "rotate-180" : "",
								)}
							>
								<ChevronDown />
							</span>
						</button>
						<div
							className={cn(
								"transition-all duration-300 overflow-hidden",
								isExpanded ? "opacity-100" : "max-h-0 opacity-0",
							)}
						>
							<div className="p-3 pt-0">
								<div className="pl-4 border-l-2 border-muted-foreground/20">
									{thinkingContent.map((content, index) => (
										<p key={index} className="mb-2 last:mb-0">
											{content}
										</p>
									))}
								</div>
							</div>
						</div>
					</div>
				)}
				<MemoizedReactMarkdown
					className="prose break-words dark:prose-invert prose-p:leading-relaxed prose-pre:p-0 w-full max-w-full overflow-hidden [word-break:break-word]"
					remarkPlugins={[remarkGfm, remarkMath]}
					components={{
						p({ children }) {
							return <p className="mb-2 last:mb-0">{children}</p>;
						},
						a({ node, href, children, ...props }) {
							const isMP4Link = href?.toLowerCase().includes(".mp4");

							if (isMP4Link && href) {
								return <VideoComponent filePath={href} />;
							}
							
							// Handle screenpipe:// timeline deep links in-app
							if (href?.startsWith("screenpipe://timeline") || href?.startsWith("screenpipe://frame")) {
								const handleTimelineClick = async (e: React.MouseEvent<HTMLAnchorElement>) => {
									e.preventDefault();
									try {
										if (href.startsWith("screenpipe://frame")) {
											const frameId = href.split("frame/")[1]?.replace(/^\//, "");
											if (frameId) {
												setPendingNavigation({ timestamp: "", frameId });
												await commands.showWindow("Main");
												await emit("navigate-to-frame", frameId);
											}
											return;
										}
										const url = new URL(href);
										const timestamp = url.searchParams.get("timestamp") || url.searchParams.get("start_time");
										if (timestamp) {
											const date = new Date(timestamp);
											if (!isNaN(date.getTime())) {
												setPendingNavigation({ timestamp });
												await commands.showWindow("Main");
												await emit("navigate-to-timestamp", timestamp);
												toast({
													title: "navigating to timestamp",
													description: `jumping to ${date.toLocaleString()}`,
												});
											}
										}
									} catch (error) {
										console.error("Failed to navigate to timeline:", error);
										toast({
											title: "navigation failed",
											description: "could not navigate to the timeline",
											variant: "destructive",
										});
									}
								};
								
								return (
									<a
										href={href}
										onClick={handleTimelineClick}
										className="underline underline-offset-2 text-blue-500 hover:text-blue-400 cursor-pointer inline"
										{...props}
									>
										{children}
									</a>
								);
							}
							
							return (
								<a
									href={href}
									target="_blank"
									rel="noopener noreferrer"
									{...props}
								>
									{children}
								</a>
							);
						},
						code({ node, className, children, ...props }) {
							const content = String(children).replace(/\n$/, "");
							const match = /language-(\w+)/.exec(className || "");
							const language = match?.[1] || "";

							const isMP4File = hasMP4File(content);

							// Render mermaid diagrams
							if (language === "mermaid") {
								return <MermaidDiagram chart={content} />;
							}

							if (isMP4File || !match) {
								if (isMP4File) {
									return <VideoComponent filePath={content.trim()} />;
								}
								return (
									<code
										className="px-1 py-0.5 rounded-sm font-mono text-sm break-all"
										{...props}
									>
										{content}
									</code>
								);
							}

							return (
								<CodeBlock
									key={Math.random()}
									language={language}
									value={content}
									{...props}
								/>
							);
						},
					}}
				>
					{processThinkContent(message.content)}
				</MemoizedReactMarkdown>
				<ChatMessageActions message={message} />
			</div>
		</div>
	);
}
