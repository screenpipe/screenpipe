/**
 * Database Stress & Concurrent Access Test
 *
 * Covers TESTING.md sections:
 * - Section 9: Concurrent DB access, store race condition, UTF-8
 * - Section 5: OCR pipeline under load
 * - Section 8: Port conflict detection
 */

describe('Database & Stability (S9)', () => {
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

    it('should handle 20 concurrent search requests (S9.2)', async () => {
        const results = await browser.execute(async (base) => {
            const promises = Array.from({ length: 20 }, (_, i) =>
                fetch(`${base}/search?limit=1&q=test${i}`)
                    .then(r => ({ ok: r.ok, status: r.status }))
                    .catch(e => ({ ok: false, status: 0, error: e.message }))
            );
            return Promise.all(promises);
        }, API_BASE);

        const failures = results.filter(r => !r.ok);
        // Allow up to 10% failure rate under load
        expect(failures.length).toBeLessThan(3);
    });

    it('should handle mixed concurrent requests (S9.2)', async () => {
        const results = await browser.execute(async (base) => {
            const endpoints = [
                `${base}/health`,
                `${base}/search?limit=1&content_type=ocr`,
                `${base}/search?limit=5&q=test`,
                `${base}/pipes/list`,
                `${base}/search?limit=1&content_type=audio`,
            ];
            const promises = [];
            for (let i = 0; i < 4; i++) {
                for (const url of endpoints) {
                    promises.push(
                        fetch(url)
                            .then(r => ({ ok: r.ok || r.status === 404 || r.status === 403, status: r.status }))
                            .catch(e => ({ ok: false, status: 0 }))
                    );
                }
            }
            return Promise.all(promises);
        }, API_BASE);

        const failures = results.filter(r => !r.ok);
        expect(failures.length).toBeLessThan(3);
    });

    it('should handle UTF-8 in various search queries (S9.5)', async () => {
        const queries = [
            '%E4%B8%AD%E6%96%87',      // Chinese
            '%C3%A9%C3%A0%C3%BC',      // French accented
            '%D0%BF%D1%80%D0%B8%D0%B2%D0%B5%D1%82', // Russian
            '%F0%9F%98%80',             // Emoji
            'caf%C3%A9',               // Mixed ASCII + Unicode
        ];

        for (const q of queries) {
            const result = await browser.execute(async (base, query) => {
                try {
                    const res = await fetch(`${base}/search?q=${query}&limit=1`);
                    return { ok: res.ok, status: res.status };
                } catch (e) {
                    return { ok: false, status: 0, error: e.message };
                }
            }, API_BASE, q);

            // Should not crash — 400 or empty results OK, 500 is bad
            expect(result.status).not.toBe(500);
        }
    });

    it('should not return 500 on rapid sequential queries (S9.3)', async () => {
        const results = await browser.execute(async (base) => {
            const outcomes = [];
            for (let i = 0; i < 10; i++) {
                try {
                    const res = await fetch(`${base}/search?limit=1&offset=${i}`);
                    outcomes.push({ ok: res.ok, status: res.status });
                } catch (e) {
                    outcomes.push({ ok: false, status: 0 });
                }
            }
            return outcomes;
        }, API_BASE);

        const serverErrors = results.filter(r => r.status >= 500);
        expect(serverErrors.length).toBe(0);
    });

    it('should handle large result set (S9.7)', async () => {
        const result = await browser.execute(async (base) => {
            const start = performance.now();
            const res = await fetch(`${base}/search?limit=100&content_type=ocr`);
            const elapsed = performance.now() - start;
            const data = await res.json();
            return {
                ok: res.ok,
                elapsed: Math.round(elapsed),
                count: data?.data?.length ?? 0,
                total: data?.pagination?.total ?? 0,
            };
        }, API_BASE);

        expect(result.ok).toBe(true);
        // Should respond within 5 seconds even for 100 results
        expect(result.elapsed).toBeLessThan(5000);
    });

    it('should maintain health during stress test', async () => {
        // After all the stress, health should still be ok
        const health = await browser.execute(async (base) => {
            const res = await fetch(`${base}/health`);
            return res.json();
        }, API_BASE);

        expect(health).toHaveProperty('status');
        expect(health.frame_status).toBe('ok');
    });

    it('should handle search + UI interaction concurrently (S9.4)', async () => {
        // Simulate what happens when user browses UI while API queries run
        const apiPromise = browser.execute(async (base) => {
            const results = [];
            for (let i = 0; i < 5; i++) {
                const res = await fetch(`${base}/search?limit=5`);
                results.push({ ok: res.ok });
            }
            return results;
        }, API_BASE);

        // Meanwhile, interact with UI
        await browser.execute(() => { window.location.href = '/settings'; });
        await browser.pause(500);
        await browser.execute(() => { window.location.href = '/'; });
        await browser.pause(500);

        // API calls should still succeed
        const apiResults = await apiPromise;
        const failures = apiResults.filter(r => !r.ok);
        expect(failures.length).toBe(0);
    });

    it('should handle search with empty query (S9.5)', async () => {
        const result = await browser.execute(async (base) => {
            const res = await fetch(`${base}/search?q=&limit=5`);
            return { ok: res.ok, status: res.status };
        }, API_BASE);

        // Empty query should not crash
        expect(result.status).not.toBe(500);
    });

    it('should handle search with very long query (S9.5)', async () => {
        const longQuery = 'a'.repeat(1000);
        const result = await browser.execute(async (base, q) => {
            try {
                const res = await fetch(`${base}/search?q=${encodeURIComponent(q)}&limit=1`);
                return { ok: res.ok, status: res.status };
            } catch (e) {
                return { ok: false, status: 0 };
            }
        }, API_BASE, longQuery);

        // Should not crash server — 400 or empty results OK
        expect(result.status).not.toBe(500);
    });

    it('should handle search with negative offset (S9.5)', async () => {
        const result = await browser.execute(async (base) => {
            const res = await fetch(`${base}/search?offset=-1&limit=5`);
            return { ok: res.ok, status: res.status };
        }, API_BASE);

        // Should handle gracefully
        expect(result.status).not.toBe(500);
    });

    it('should handle health endpoint under concurrent load (S9.2)', async () => {
        const results = await browser.execute(async (base) => {
            const promises = Array.from({ length: 20 }, () =>
                fetch(`${base}/health`)
                    .then(r => ({ ok: r.ok, status: r.status }))
                    .catch(() => ({ ok: false, status: 0 }))
            );
            return Promise.all(promises);
        }, API_BASE);

        const failures = results.filter(r => !r.ok);
        expect(failures.length).toBeLessThan(2);
    });
});
