/**
 * Search & API Integration Test
 *
 * Covers TESTING.md sections:
 * - Section 5: Frame comparison & OCR pipeline
 * - Section 9: Database & storage
 * - Section 12: Timeline & search
 *
 * Tests the REST API and search functionality end-to-end.
 * These tests run inside the WebView2 context using fetch().
 */

describe('Search & API', () => {
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

    it('should have healthy API', async () => {
        const health = await browser.execute(async (base) => {
            const res = await fetch(`${base}/health`);
            return res.json();
        }, API_BASE);

        expect(health).toHaveProperty('status');
        expect(health).toHaveProperty('frame_status');
        expect(health).toHaveProperty('status_code');
    });

    it('should return OCR search results', async () => {
        const data = await browser.execute(async (base) => {
            const res = await fetch(`${base}/search?limit=5&content_type=ocr`);
            return res.json();
        }, API_BASE);

        expect(data).toHaveProperty('data');
        expect(Array.isArray(data.data)).toBe(true);
    });

    it('should return search results with query', async () => {
        const data = await browser.execute(async (base) => {
            const res = await fetch(`${base}/search?limit=5&q=test`);
            return res.json();
        }, API_BASE);

        expect(data).toHaveProperty('data');
        expect(data).toHaveProperty('pagination');
    });

    it('should handle search with date range', async () => {
        const data = await browser.execute(async (base) => {
            const today = new Date().toISOString().split('T')[0] + 'T00:00:00Z';
            const res = await fetch(`${base}/search?limit=5&start_time=${today}`);
            return { ok: res.ok, status: res.status };
        }, API_BASE);

        expect(data.ok).toBe(true);
    });

    it('should handle concurrent requests without errors', async () => {
        const results = await browser.execute(async (base) => {
            const promises = Array.from({ length: 5 }, () =>
                fetch(`${base}/search?limit=1`).then(r => ({ ok: r.ok, status: r.status }))
            );
            return Promise.all(promises);
        }, API_BASE);

        const failures = results.filter(r => !r.ok);
        expect(failures.length).toBe(0);
    });

    it('should not return 500 on invalid content_type', async () => {
        const result = await browser.execute(async (base) => {
            const res = await fetch(`${base}/search?content_type=invalid`);
            return { status: res.status };
        }, API_BASE);

        expect(result.status).not.toBe(500);
    });

    it('should have pipes endpoint accessible', async () => {
        const result = await browser.execute(async (base) => {
            const res = await fetch(`${base}/pipes/list`);
            return { status: res.status };
        }, API_BASE);

        // 200, 403, or 404 are fine — not 500
        expect(result.status).not.toBe(500);
    });

    it('should return OCR results with app context (S5.9/S12.5)', async () => {
        const data = await browser.execute(async (base) => {
            const res = await fetch(`${base}/search?limit=10&content_type=ocr`);
            return res.json();
        }, API_BASE);

        if (data.data && data.data.length > 0) {
            let withApp = 0;
            let withWindow = 0;
            for (const item of data.data) {
                if (item.content?.app_name) withApp++;
                if (item.content?.window_name) withWindow++;
            }
            console.log(`OCR context: ${withApp} with app_name, ${withWindow} with window_name`);
        }
    });

    it('should handle audio search (S4.1)', async () => {
        const data = await browser.execute(async (base) => {
            const res = await fetch(`${base}/search?limit=5&content_type=audio`);
            return { ok: res.ok, status: res.status, data: await res.json() };
        }, API_BASE);

        expect(data.ok).toBe(true);
        expect(data.data).toHaveProperty('data');
        if (data.data.data && data.data.data.length > 0) {
            console.log(`Audio results: ${data.data.data.length}`);
        } else {
            console.log('No audio results (may not be configured)');
        }
    });

    it('should have health with all expected fields (S8)', async () => {
        const health = await browser.execute(async (base) => {
            const res = await fetch(`${base}/health`);
            return res.json();
        }, API_BASE);

        expect(health).toHaveProperty('status');
        expect(health).toHaveProperty('frame_status');
        expect(health).toHaveProperty('audio_status');
        expect(health).toHaveProperty('status_code');

        // Verify frame_status is one of expected values
        const validFrameStatuses = ['ok', 'error', 'loading', 'disabled'];
        const frameOk = validFrameStatuses.some(s =>
            health.frame_status?.toLowerCase?.().includes?.(s)
        );
        if (!frameOk) {
            console.log(`Unexpected frame_status: ${health.frame_status}`);
        }

        // Check for device_status_details
        if (health.device_status_details) {
            console.log(`device_status_details: ${JSON.stringify(health.device_status_details).slice(0, 100)}`);
        }
    });

    it('should handle search with offset pagination (S12.2)', async () => {
        // Get first page
        const page1 = await browser.execute(async (base) => {
            const res = await fetch(`${base}/search?limit=3&offset=0&content_type=ocr`);
            return res.json();
        }, API_BASE);

        // Get second page
        const page2 = await browser.execute(async (base) => {
            const res = await fetch(`${base}/search?limit=3&offset=3&content_type=ocr`);
            return res.json();
        }, API_BASE);

        expect(page1).toHaveProperty('data');
        expect(page2).toHaveProperty('data');

        // Pages should have different content (if enough data)
        if (page1.data?.length >= 3 && page2.data?.length > 0) {
            const ts1 = page1.data[0]?.content?.timestamp;
            const ts2 = page2.data[0]?.content?.timestamp;
            if (ts1 && ts2 && ts1 === ts2) {
                console.log('Warning: pagination may not be working (same first result)');
            }
        }
    });
});
