import { describe, it, expect, vi } from "vitest";
import "../../vitest.setup";
import { render, fireEvent } from "@testing-library/react";
import {
	TextOverlay,
	isUrl,
	normalizeUrl,
	extractUrlsFromText,
} from "../text-overlay";
import type { TextPosition } from "@/lib/hooks/use-frame-text-data";

// Mock @tauri-apps/plugin-shell
vi.mock("@tauri-apps/plugin-shell", () => ({
	open: vi.fn().mockResolvedValue(undefined),
}));

describe("TextOverlay", () => {
	const createTextPosition = (
		text: string,
		left: number,
		top: number,
		width: number,
		height: number,
		confidence = 0.9
	): TextPosition => ({
		text,
		confidence,
		bounds: { left, top, width, height },
	});

	it("should render nothing when textPositions is empty", () => {
		const { container } = render(
			<TextOverlay
				textPositions={[]}
				originalWidth={1920}
				originalHeight={1080}
				displayedWidth={960}
				displayedHeight={540}
			/>
		);
		expect(container.firstChild).toBeNull();
	});

	it("should render nothing when no URLs and selection disabled", () => {
		const positions = [
			createTextPosition("Hello", 0.1, 0.05, 0.08, 0.02),
			createTextPosition("World", 0.2, 0.05, 0.1, 0.02),
		];
		const { container } = render(
			<TextOverlay
				textPositions={positions}
				originalWidth={1920}
				originalHeight={1080}
				displayedWidth={960}
				displayedHeight={540}
				selectable={false}
			/>
		);
		expect(container.firstChild).toBeNull();
	});

	it("should render clickable text blocks when selectable", () => {
		const positions = [
			createTextPosition("Hello world", 0.1, 0.05, 0.2, 0.02),
		];
		const { container } = render(
			<TextOverlay
				textPositions={positions}
				originalWidth={1920}
				originalHeight={1080}
				displayedWidth={960}
				displayedHeight={540}
				selectable={true}
			/>
		);
		expect(container.firstChild).not.toBeNull();
		// Should have clickable block divs (one per text position)
		const blocks = container.querySelectorAll('[style*="pointer"]');
		expect(blocks.length).toBeGreaterThan(0);
	});

	it("should render a whole-block URL as clickable link", () => {
		const positions = [
			createTextPosition("https://example.com", 0.1, 0.05, 0.2, 0.02),
		];
		const { container } = render(
			<TextOverlay
				textPositions={positions}
				originalWidth={1920}
				originalHeight={1080}
				displayedWidth={960}
				displayedHeight={540}
				clickableUrls={true}
			/>
		);
		const link = container.querySelector("a");
		expect(link).toBeInTheDocument();
		expect(link).toHaveAttribute("href", "https://example.com");
	});

	it("should extract and render URLs embedded in longer text", () => {
		const positions = [
			createTextPosition(
				"GitHub: https://github.com/mediar-ai/screenpipe Demo: https://screenpi.pe/demo",
				0.1,
				0.3,
				0.5,
				0.02
			),
		];
		const { container } = render(
			<TextOverlay
				textPositions={positions}
				originalWidth={1920}
				originalHeight={1080}
				displayedWidth={960}
				displayedHeight={540}
				clickableUrls={true}
			/>
		);
		const links = container.querySelectorAll("a");
		expect(links.length).toBe(2);
		expect(links[0]).toHaveAttribute(
			"href",
			"https://github.com/mediar-ai/screenpipe"
		);
		expect(links[1]).toHaveAttribute(
			"href",
			"https://screenpi.pe/demo"
		);
	});

	it("should filter out off-screen positions (bounds > 1.0)", () => {
		const positions = [
			createTextPosition("https://onscreen.com", 0.1, 0.05, 0.2, 0.02),
			createTextPosition(
				"https://offscreen.com",
				1.5,
				0.05,
				0.2,
				0.02
			),
		];
		const { container } = render(
			<TextOverlay
				textPositions={positions}
				originalWidth={1920}
				originalHeight={1080}
				displayedWidth={960}
				displayedHeight={540}
				clickableUrls={true}
			/>
		);
		const links = container.querySelectorAll("a");
		expect(links.length).toBe(1);
		expect(links[0]).toHaveAttribute("href", "https://onscreen.com");
	});

	it("should use shell.open on click", async () => {
		const { open: mockShellOpen } = await import(
			"@tauri-apps/plugin-shell"
		);
		const positions = [
			createTextPosition(
				"https://test.com/page",
				0.1,
				0.05,
				0.2,
				0.02
			),
		];
		const { container } = render(
			<TextOverlay
				textPositions={positions}
				originalWidth={1920}
				originalHeight={1080}
				displayedWidth={960}
				displayedHeight={540}
				clickableUrls={true}
			/>
		);
		const link = container.querySelector("a");
		fireEvent.click(link!);
		expect(mockShellOpen).toHaveBeenCalledWith("https://test.com/page");
	});

	it("should show visible underline on links", () => {
		const positions = [
			createTextPosition(
				"https://example.com",
				0.1,
				0.3,
				0.2,
				0.02
			),
		];
		const { container } = render(
			<TextOverlay
				textPositions={positions}
				originalWidth={1920}
				originalHeight={1080}
				displayedWidth={960}
				displayedHeight={540}
				clickableUrls={true}
			/>
		);
		const link = container.querySelector("a") as HTMLElement;
		expect(link.style.borderBottom).toContain("solid");
		expect(link.style.cursor).toBe("pointer");
	});

	it("should expand small click targets to minimum height", () => {
		const positions = [
			createTextPosition("https://tiny.com", 0.1, 0.3, 0.2, 0.02),
		];
		const { container } = render(
			<TextOverlay
				textPositions={positions}
				originalWidth={1000}
				originalHeight={1000}
				displayedWidth={500}
				displayedHeight={500}
			/>
		);
		const link = container.querySelector("a") as HTMLElement;
		const height = parseFloat(link.style.height);
		expect(height).toBeGreaterThanOrEqual(24);
	});

	it("should detect URLs with well-known TLDs", () => {
		const positions = [
			createTextPosition("github.com", 0.1, 0.1, 0.15, 0.02),
			createTextPosition("example.org", 0.1, 0.2, 0.1, 0.02),
		];
		const { container } = render(
			<TextOverlay
				textPositions={positions}
				originalWidth={1920}
				originalHeight={1080}
				displayedWidth={960}
				displayedHeight={540}
				clickableUrls={true}
			/>
		);
		const links = container.querySelectorAll("a");
		expect(links.length).toBe(2);
	});

	it("should render nothing when displayed dimensions are invalid", () => {
		const positions = [
			createTextPosition(
				"https://example.com",
				0.1,
				0.05,
				0.2,
				0.02
			),
		];
		const { container } = render(
			<TextOverlay
				textPositions={positions}
				originalWidth={1920}
				originalHeight={1080}
				displayedWidth={0}
				displayedHeight={540}
			/>
		);
		expect(container.firstChild).toBeNull();
	});
});

describe("extractUrlsFromText", () => {
	it("should extract https URLs from mixed text", () => {
		const urls = extractUrlsFromText(
			"GitHub: https://github.com/mediar-ai/screenpipe Demo: https://screenpi.pe/demo"
		);
		expect(urls.length).toBe(2);
		expect(urls[0].normalizedUrl).toBe(
			"https://github.com/mediar-ai/screenpipe"
		);
		expect(urls[1].normalizedUrl).toBe("https://screenpi.pe/demo");
	});

	it("should extract www URLs", () => {
		const urls = extractUrlsFromText(
			"Visit www.example.com for more info"
		);
		expect(urls.length).toBe(1);
		expect(urls[0].normalizedUrl).toBe("https://www.example.com");
	});

	it("should not extract bare domains (only https/www)", () => {
		const urls = extractUrlsFromText(
			"Check app.crisp.chat and screenpi.pe/demo"
		);
		expect(urls.length).toBe(0);
	});

	it("should extract explicit https domains", () => {
		const urls = extractUrlsFromText(
			"Visit https://github.com and https://screenpi.pe/demo"
		);
		expect(urls.length).toBe(2);
	});

	it("should compute approximate position fractions", () => {
		const text = "Go to https://example.com now";
		const urls = extractUrlsFromText(text);
		expect(urls.length).toBe(1);
		// "Go to " is 6 chars, URL starts at index 6
		expect(urls[0].startFraction).toBeCloseTo(6 / text.length, 1);
		expect(urls[0].widthFraction).toBeCloseTo(
			"https://example.com".length / text.length,
			1
		);
	});

	it("should return empty for text with no URLs", () => {
		expect(extractUrlsFromText("Hello world")).toEqual([]);
		expect(extractUrlsFromText("No urls here")).toEqual([]);
	});

	it("should strip trailing punctuation", () => {
		const urls = extractUrlsFromText(
			"See https://example.com. Also check https://test.com)"
		);
		expect(urls.length).toBe(2);
		expect(urls[0].normalizedUrl).toBe("https://example.com");
		expect(urls[1].normalizedUrl).toBe("https://test.com");
	});

	it("should handle concatenated URLs (no space between)", () => {
		// OCR sometimes concatenates: "https://github.com/orgDemo: https://site.com"
		const urls = extractUrlsFromText(
			"https://github.com/mediar-ai/screenpipeDemo: https://screenpi.pe/demo"
		);
		// The first URL will grab "https://github.com/mediar-ai/screenpipeDemo:" 
		// but trailing punctuation strip removes the colon
		// The second URL is clean
		expect(urls.length).toBe(2);
		expect(urls[1].normalizedUrl).toBe("https://screenpi.pe/demo");
	});
});

describe("isUrl", () => {
	it("should detect https URLs", () => {
		expect(isUrl("https://example.com")).toBe(true);
		expect(isUrl("https://example.com/path")).toBe(true);
	});

	it("should detect http URLs", () => {
		expect(isUrl("http://example.com")).toBe(true);
	});

	it("should detect www URLs", () => {
		expect(isUrl("www.example.com")).toBe(true);
	});

	it("should detect domain-like strings with well-known TLDs", () => {
		expect(isUrl("example.com")).toBe(true);
		expect(isUrl("example.io")).toBe(true);
		expect(isUrl("github.dev")).toBe(true);
	});

	it("should not match OCR garbled text or uncommon TLDs", () => {
		expect(isUrl("ostnuo.co")).toBe(false);
		expect(isUrl("10a2SV.Om")).toBe(false);
		expect(isUrl("gaunvo.co")).toBe(false);
		expect(isUrl("screenpi.pe")).toBe(false);
		expect(isUrl("app.crisp.chat")).toBe(false);
	});

	it("should not detect regular text", () => {
		expect(isUrl("hello")).toBe(false);
		expect(isUrl("hello world")).toBe(false);
		expect(isUrl("reddit .com")).toBe(false);
		expect(isUrl("test.a")).toBe(false);
	});
});

describe("normalizeUrl", () => {
	it("should keep https URLs unchanged", () => {
		expect(normalizeUrl("https://example.com")).toBe(
			"https://example.com"
		);
	});

	it("should add https to www URLs", () => {
		expect(normalizeUrl("www.example.com")).toBe(
			"https://www.example.com"
		);
	});

	it("should add https to bare domains", () => {
		expect(normalizeUrl("example.com")).toBe("https://example.com");
	});
});
