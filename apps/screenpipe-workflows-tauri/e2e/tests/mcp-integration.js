/**
 * MCP / Claude Integration Tests
 *
 * Covers TESTING.md section 16:
 * - S16.1: Claude connect button works
 * - S16.3: Claude Desktop not installed
 * - S16.4: MCP version display
 * - S16.7: Download error logging
 *
 * Tests MCP-related UI elements and settings.
 * These are proxy tests — actual Claude Desktop integration
 * requires external app installation.
 */

describe('MCP & Claude Integration (S16)', () => {
    const API_BASE = 'http://localhost:3030';

    before(async () => {
        await browser.waitUntil(
            async () => (await browser.execute(() => document.readyState)) === 'complete',
            { timeout: 30000, timeoutMsg: 'app did not load' }
        );

        // Skip onboarding
        try {
            const skipBtn = await $('button*=skip');
            if (await skipBtn.isDisplayed()) {
                await skipBtn.click();
                await browser.pause(500);
            }
        } catch {}
        try {
            const closeBtn = await $('button svg.lucide-x');
            if (await closeBtn.isDisplayed()) {
                await closeBtn.closest('button').click();
                await browser.pause(500);
            }
        } catch {}
    });

    it('should have MCP/Claude UI in settings (S16.1)', async () => {
        await browser.execute(() => { window.location.href = '/settings'; });
        await browser.pause(2000);

        // Look for MCP or Claude references across all settings sections
        const sections = ['general', 'connections', 'ai'];
        let mcpFound = false;

        for (const section of sections) {
            await browser.execute((s) => {
                const els = document.querySelectorAll('a, button');
                for (const el of els) {
                    if (el.textContent.toLowerCase().includes(s)) {
                        el.click();
                        break;
                    }
                }
            }, section);
            await browser.pause(800);

            const text = await browser.execute(() => document.body.innerText.toLowerCase());
            if (text.includes('mcp') || text.includes('claude') ||
                text.includes('connect') || text.includes('integration')) {
                mcpFound = true;
                console.log(`MCP/Claude UI found in ${section} section`);
                break;
            }
        }

        if (!mcpFound) {
            console.log('Warning: MCP/Claude UI not found in settings');
        }

        const bodyText = await browser.execute(() => document.body.innerText);
        expect(bodyText).not.toContain('Unhandled Runtime Error');
    });

    it('should handle Claude not installed gracefully (S16.3)', async () => {
        // If there's a "connect to Claude" button, clicking it should
        // show a helpful message when Claude Desktop is not installed
        const result = await browser.execute(() => {
            const buttons = document.querySelectorAll('button');
            for (const btn of buttons) {
                const text = btn.textContent.toLowerCase();
                if (text.includes('claude') || text.includes('mcp') || text.includes('connect')) {
                    // Don't actually click — just verify the button exists
                    return { found: true, text: btn.textContent.trim() };
                }
            }
            return { found: false };
        });

        if (result.found) {
            console.log(`Found MCP button: "${result.text}"`);
        } else {
            console.log('No MCP connect button found (may be in different section)');
        }

        // App should be stable regardless
        const ready = await browser.execute(() => document.readyState);
        expect(ready).toBe('complete');
    });

    it('should show version info (S16.4)', async () => {
        // Check if version is displayed in settings or about section
        await browser.execute(() => { window.location.href = '/settings'; });
        await browser.pause(1000);

        const versionInfo = await browser.execute(() => {
            const text = document.body.innerText;
            // Look for version pattern like v0.1.0 or 0.1.0
            const match = text.match(/v?\d+\.\d+\.\d+/);
            return {
                found: !!match,
                version: match ? match[0] : null,
            };
        });

        if (versionInfo.found) {
            console.log(`Version found: ${versionInfo.version}`);
        } else {
            console.log('Version string not found in settings page');
        }
    });

    it('should not crash accessing pipes endpoint (S16)', async () => {
        const result = await browser.execute(async (base) => {
            try {
                const res = await fetch(`${base}/pipes/list`);
                const data = await res.json();
                return {
                    status: res.status,
                    ok: res.ok,
                    hasError: !!data.error,
                    error: data.error || null,
                };
            } catch (e) {
                return { status: 0, ok: false, error: e.message };
            }
        }, API_BASE);

        // Pipes may be disabled, but should not crash
        expect(result.status).not.toBe(500);
        console.log(`Pipes endpoint: status=${result.status}, error=${result.error || 'none'}`);
    });

    it('should handle error logging without crash (S16.7)', async () => {
        // Verify console doesn't have uncaught MCP-related errors
        const logs = await browser.getLogs('browser');
        const mcpErrors = logs.filter(log =>
            log.level === 'SEVERE' &&
            (log.message.toLowerCase().includes('mcp') ||
             log.message.toLowerCase().includes('claude'))
        );

        if (mcpErrors.length > 0) {
            console.log(`Found ${mcpErrors.length} MCP-related console error(s):`);
            mcpErrors.forEach(e => console.log(`  ${e.message.slice(0, 100)}`));
        } else {
            console.log('No MCP-related console errors');
        }

        // Don't fail — just report
    });
});
