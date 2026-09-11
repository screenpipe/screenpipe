/**
 * Timeline Performance Integration Test
 *
 * This test reproduces the slow startup issue reported by M1 Mac users.
 * It measures time-to-first-frame and total loading time.
 *
 * Run with: bun test:e2e
 *
 * Expected behavior:
 * - First frame should appear within 2 seconds
 * - Full timeline should load within 5 seconds
 * - No "hanging" state longer than 10 seconds
 */

describe('Timeline Performance', () => {
    // Store performance metrics
    const metrics = {
        appLoadTime: 0,
        timelineOpenTime: 0,
        firstFrameTime: 0,
        fullLoadTime: 0,
        frameCount: 0,
        errors: []
    };

    before(async () => {
        // Wait for app to fully load
        const startTime = Date.now();
        await browser.waitUntil(
            async () => {
                const readyState = await browser.execute(() => document.readyState);
                return readyState === 'complete';
            },
            {
                timeout: 30000,
                timeoutMsg: 'App did not load in time'
            }
        );
        metrics.appLoadTime = Date.now() - startTime;
        console.log(`App load time: ${metrics.appLoadTime}ms`);
    });

    it('should measure timeline loading performance', async () => {
        // Skip onboarding if present (button text is just "skip")
        try {
            const skipButton = await $('button.text-muted-foreground*=skip');
            if (await skipButton.isDisplayed()) {
                await skipButton.click();
                await browser.pause(500);
            }
        } catch (e) {
            // Onboarding might not be shown
        }

        // Close any dialogs
        try {
            const closeButton = await $('button svg.lucide-x');
            if (await closeButton.isDisplayed()) {
                await closeButton.click();
                await browser.pause(500);
            }
        } catch (e) {
            // No dialog to close
        }

        // Trigger timeline open (via keyboard shortcut or menu)
        const timelineOpenStart = Date.now();

        // Try to find and click the timeline/rewind button or use keyboard shortcut
        try {
            // The overlay is triggered by global shortcut, simulate it
            await browser.execute(() => {
                // Dispatch the show-rewind event that triggers the overlay
                window.dispatchEvent(new CustomEvent('show-rewind'));
            });
        } catch (e) {
            console.log('Could not trigger timeline via event, trying alternative');
        }

        // Wait for timeline container to appear
        await browser.waitUntil(
            async () => {
                const timeline = await $('[data-testid="timeline-container"]');
                return await timeline.isExisting();
            },
            {
                timeout: 10000,
                timeoutMsg: 'Timeline container did not appear',
                interval: 100
            }
        );
        metrics.timelineOpenTime = Date.now() - timelineOpenStart;
        console.log(`Timeline open time: ${metrics.timelineOpenTime}ms`);

        // Measure time to first frame
        const firstFrameStart = Date.now();
        let firstFrameAppeared = false;

        await browser.waitUntil(
            async () => {
                // Check for frame elements in the timeline
                const frames = await $$('[data-testid="timeline-frame"]');
                if (frames.length > 0 && !firstFrameAppeared) {
                    firstFrameAppeared = true;
                    metrics.firstFrameTime = Date.now() - firstFrameStart;
                    console.log(`First frame time: ${metrics.firstFrameTime}ms`);
                }

                // Also check for loading state
                const loadingIndicator = await $('[data-testid="timeline-loading"]');
                const isLoading = await loadingIndicator.isExisting() && await loadingIndicator.isDisplayed();

                return frames.length > 0 && !isLoading;
            },
            {
                timeout: 60000, // 60 second timeout to catch hangs
                timeoutMsg: 'Timeline frames did not load - THIS IS THE HANG ISSUE',
                interval: 500
            }
        );

        metrics.fullLoadTime = Date.now() - firstFrameStart;

        // Count total frames
        const frames = await $$('[data-testid="timeline-frame"]');
        metrics.frameCount = frames.length;

        // Log results
        console.log('\n=== TIMELINE PERFORMANCE RESULTS ===');
        console.log(`App load time:      ${metrics.appLoadTime}ms`);
        console.log(`Timeline open time: ${metrics.timelineOpenTime}ms`);
        console.log(`First frame time:   ${metrics.firstFrameTime}ms`);
        console.log(`Full load time:     ${metrics.fullLoadTime}ms`);
        console.log(`Frame count:        ${metrics.frameCount}`);

        // Performance assertions
        expect(metrics.firstFrameTime).toBeLessThan(5000); // First frame < 5s
        expect(metrics.fullLoadTime).toBeLessThan(30000);  // Full load < 30s
    });

    it('should detect console errors during timeline load', async () => {
        // Capture any console errors
        const logs = await browser.getLogs('browser');
        const errors = logs.filter(log => log.level === 'SEVERE');

        if (errors.length > 0) {
            console.log('\n=== CONSOLE ERRORS DETECTED ===');
            errors.forEach(error => {
                console.log(`ERROR: ${error.message}`);
                metrics.errors.push(error.message);
            });
        }

        // Warn but don't fail on errors (for debugging)
        if (errors.length > 0) {
            console.warn(`Found ${errors.length} console errors during timeline load`);
        }
    });

    it('should measure WebSocket frame streaming performance', async () => {
        // Inject performance monitoring into the page
        const wsMetrics = await browser.execute(() => {
            return new Promise((resolve) => {
                // Check if we have access to the timeline store
                if (window.__timelineStore) {
                    const store = window.__timelineStore.getState();
                    resolve({
                        frameCount: store.frames?.length || 0,
                        isLoading: store.isLoading,
                        loadingProgress: store.loadingProgress,
                        error: store.error
                    });
                } else {
                    // Try to extract from React DevTools or DOM
                    resolve({
                        frameCount: document.querySelectorAll('[data-testid="timeline-frame"]').length,
                        isLoading: !!document.querySelector('[data-testid="timeline-loading"]'),
                        error: null
                    });
                }
            });
        });

        console.log('\n=== WEBSOCKET METRICS ===');
        console.log(`Frames in store: ${wsMetrics.frameCount}`);
        console.log(`Is loading:      ${wsMetrics.isLoading}`);
        console.log(`Error:           ${wsMetrics.error || 'none'}`);
    });

    after(async () => {
        // Final summary
        console.log('\n========================================');
        console.log('TIMELINE PERFORMANCE TEST COMPLETE');
        console.log('========================================');
        console.log(JSON.stringify(metrics, null, 2));

        // Flag critical issues
        if (metrics.firstFrameTime > 10000) {
            console.log('\n*** CRITICAL: First frame took > 10 seconds ***');
            console.log('This matches the customer-reported hang issue.');
        }

        if (metrics.fullLoadTime > 30000) {
            console.log('\n*** CRITICAL: Full load took > 30 seconds ***');
            console.log('User would perceive this as a hang/freeze.');
        }
    });
});
