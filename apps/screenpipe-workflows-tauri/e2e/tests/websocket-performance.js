/**
 * WebSocket Timeline Performance Test
 *
 * This test directly measures the WebSocket frame streaming performance
 * without needing the full UI. It connects to the screenpipe server
 * and measures how long it takes to receive frames.
 *
 * Prerequisites:
 * - screenpipe server running on localhost:3030
 * - Database populated with frames
 *
 * Run standalone:
 *   node e2e/tests/websocket-performance.js
 *
 * Or via test runner:
 *   bun test:e2e
 */

const WebSocket = require('ws');

// Configuration
const WS_URL = 'ws://localhost:3030/stream/frames';
const TIMEOUT_MS = 60000; // 60 seconds - matches customer-reported hang time

class TimelinePerformanceTester {
    constructor() {
        this.metrics = {
            connectionTime: 0,
            firstFrameTime: 0,
            totalFrames: 0,
            totalBytes: 0,
            batchCount: 0,
            errors: [],
            timeToFrameCounts: {} // time -> frame count
        };
        this.startTime = null;
        this.firstFrameReceived = false;
    }

    async runTest() {
        console.log('\n=== WebSocket Timeline Performance Test ===\n');

        return new Promise((resolve, reject) => {
            const connectionStart = Date.now();

            const ws = new WebSocket(WS_URL);

            // Connection timeout
            const timeout = setTimeout(() => {
                ws.close();
                reject(new Error(`WebSocket connection timed out after ${TIMEOUT_MS}ms`));
            }, TIMEOUT_MS);

            ws.on('open', () => {
                this.metrics.connectionTime = Date.now() - connectionStart;
                console.log(`Connected in ${this.metrics.connectionTime}ms`);

                // Request frames for today
                const now = new Date();
                const startOfDay = new Date(now);
                startOfDay.setHours(0, 0, 0, 0);

                const request = {
                    start_time: startOfDay.toISOString(),
                    end_time: now.toISOString(),
                    order: 'descending'
                };

                console.log(`Requesting frames from ${request.start_time} to ${request.end_time}`);
                this.startTime = Date.now();

                ws.send(JSON.stringify(request));
            });

            ws.on('message', (data) => {
                const elapsed = Date.now() - this.startTime;
                const dataStr = data.toString();

                // Skip keep-alive messages
                if (dataStr === '"keep-alive-text"') {
                    console.log(`  [${elapsed}ms] Keep-alive received`);
                    return;
                }

                try {
                    const parsed = JSON.parse(dataStr);

                    // Handle error messages
                    if (parsed.error) {
                        this.metrics.errors.push(parsed.error);
                        console.log(`  [${elapsed}ms] ERROR: ${parsed.error}`);
                        return;
                    }

                    // Handle batched frames
                    if (Array.isArray(parsed)) {
                        const frameCount = parsed.length;
                        this.metrics.batchCount++;
                        this.metrics.totalFrames += frameCount;
                        this.metrics.totalBytes += dataStr.length;

                        if (!this.firstFrameReceived) {
                            this.firstFrameReceived = true;
                            this.metrics.firstFrameTime = elapsed;
                            console.log(`  [${elapsed}ms] FIRST FRAME RECEIVED! (batch of ${frameCount})`);
                        } else {
                            console.log(`  [${elapsed}ms] Batch ${this.metrics.batchCount}: +${frameCount} frames (total: ${this.metrics.totalFrames})`);
                        }

                        // Track frame count over time
                        const timeKey = Math.floor(elapsed / 1000) + 's';
                        this.metrics.timeToFrameCounts[timeKey] = this.metrics.totalFrames;
                    }
                } catch (e) {
                    console.log(`  [${elapsed}ms] Parse error: ${e.message}`);
                }
            });

            ws.on('close', () => {
                clearTimeout(timeout);
                this.printResults();
                resolve(this.metrics);
            });

            ws.on('error', (error) => {
                clearTimeout(timeout);
                this.metrics.errors.push(error.message);
                reject(error);
            });

            // Auto-close after receiving frames for 30 seconds
            setTimeout(() => {
                if (this.metrics.totalFrames > 0) {
                    console.log('\n--- Test complete (30s elapsed) ---');
                    ws.close();
                }
            }, 30000);
        });
    }

    printResults() {
        const totalTime = Date.now() - this.startTime;

        console.log('\n========================================');
        console.log('WEBSOCKET PERFORMANCE RESULTS');
        console.log('========================================');
        console.log(`Connection time:    ${this.metrics.connectionTime}ms`);
        console.log(`First frame time:   ${this.metrics.firstFrameTime}ms`);
        console.log(`Total time:         ${totalTime}ms`);
        console.log(`Total frames:       ${this.metrics.totalFrames}`);
        console.log(`Total batches:      ${this.metrics.batchCount}`);
        console.log(`Total data:         ${(this.metrics.totalBytes / 1024).toFixed(1)} KB`);
        console.log(`Errors:             ${this.metrics.errors.length}`);

        if (this.metrics.totalFrames > 0) {
            console.log(`\nThroughput:         ${(this.metrics.totalFrames / (totalTime / 1000)).toFixed(1)} frames/sec`);
            console.log(`Avg batch size:     ${(this.metrics.totalFrames / this.metrics.batchCount).toFixed(1)} frames`);
            console.log(`Avg frame size:     ${(this.metrics.totalBytes / this.metrics.totalFrames).toFixed(0)} bytes`);
        }

        console.log('\nFrame count over time:');
        Object.entries(this.metrics.timeToFrameCounts).forEach(([time, count]) => {
            console.log(`  ${time}: ${count} frames`);
        });

        // Diagnosis
        console.log('\n========================================');
        console.log('DIAGNOSIS');
        console.log('========================================');

        if (this.metrics.firstFrameTime > 5000) {
            console.log('*** PROBLEM: First frame took > 5 seconds ***');
            console.log('    This explains the "loading timeline" hang.');
            console.log('    Likely cause: Large database query without pagination.');
        } else if (this.metrics.firstFrameTime > 2000) {
            console.log('** WARNING: First frame took > 2 seconds **');
            console.log('   User will notice delay. Consider optimization.');
        } else {
            console.log('OK: First frame time is acceptable.');
        }

        if (this.metrics.totalFrames === 0) {
            console.log('*** PROBLEM: No frames received ***');
            console.log('    Either no data in database or query failed.');
        }

        if (this.metrics.errors.length > 0) {
            console.log('\n*** ERRORS DETECTED ***');
            this.metrics.errors.forEach(e => console.log(`    - ${e}`));
        }
    }
}

// Run if executed directly
if (require.main === module) {
    const tester = new TimelinePerformanceTester();
    tester.runTest()
        .then(() => process.exit(0))
        .catch((e) => {
            console.error('Test failed:', e.message);
            process.exit(1);
        });
}

// Export for use in test framework
module.exports = { TimelinePerformanceTester };
