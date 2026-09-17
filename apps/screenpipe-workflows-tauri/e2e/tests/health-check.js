describe('Project', () => {
	it('Health check', async () => {
		// Wait for app to load
		await browser.waitUntil(
			async () => {
				const readyState = await browser.execute(() => document.readyState);
				return readyState === 'complete';
			},
			{
				timeout: 10000,
				timeoutMsg: 'app did not load in time'
			}
		);

		// On Linux, WebdriverIO is not able to click on buttons, so we need to use JavaScript
		const isLinux = await browser.execute(() => {
			// Check if we're on Linux using userAgent
			const userAgent = navigator.userAgent.toLowerCase();
			return userAgent.includes('linux') && !userAgent.includes('android');
		});

		// Wait for the skip button to be visible (button text is just "skip")
		const button = await $('button.text-muted-foreground*=skip');
		await button.waitForDisplayed({ timeout: 10000 });

		if (isLinux) {
			// Use JavaScript click directly with a valid CSS selector on Linux
			await browser.execute(() => {
				const buttons = document.querySelectorAll('button.text-muted-foreground');
				for (const btn of buttons) {
					if (btn.textContent.trim() === 'skip') {
						btn.click();
						break;
					}
				}
			});
		} else {
			// Use native WebdriverIO click on Windows
			await button.waitForClickable({ timeout: 10000 });
			await button.click();
		}
		
		// Add a small delay to ensure UI has time to respond
		await browser.pause(500);

		// Close the dialog - wait for the close button to be visible
		const dialogCloseButton = await $('button.absolute.right-4.top-4 svg.lucide-x');
		await dialogCloseButton.waitForDisplayed({ timeout: 10000 });
		
		if (isLinux) {
			// Use JavaScript click directly with a valid CSS selector on Linux
			await browser.execute(() => {
				const closeButtons = document.querySelectorAll('button svg.lucide-x');
				for (const btn of closeButtons) {
					if (btn.closest('button.absolute.right-4.top-4')) {
						btn.closest('button').click();
						break;
					}
				}
			});
		} else {
			// Use native WebdriverIO click on Windows
			await dialogCloseButton.waitForClickable({ timeout: 10000 });
			await dialogCloseButton.click();
		}
		
		// Add a small delay to ensure UI has time to respond
		await browser.pause(500);

		// Click badge - wait for it to be visible
		const badge = await $('div.cursor-pointer.bg-transparent');
		await badge.waitForDisplayed({ timeout: 10000 });
		
		if (isLinux) {
			// Use JavaScript click directly with a valid CSS selector on Linux
			await browser.execute(() => {
				const badges = document.querySelectorAll('div.cursor-pointer.bg-transparent');
				if (badges.length > 0) {
					badges[0].click();
				}
			});
		} else {
			// Use native WebdriverIO click on Windows
			await badge.waitForClickable({ timeout: 10000 });
			await badge.click();
		}
		
		// Add a small delay to ensure UI has time to respond
		await browser.pause(500);

		// Wait until the status message is correct
		await browser.waitUntil(
			async () => {
				const statusElement = await $('div.flex-grow p.text-sm');
				const statusMessage = await statusElement.getText();
				return statusMessage.includes('screenpipe is running smoothly');
			},
			{
				timeout: 60000, // maximum wait time (1 minute)
				timeoutMsg: 'status message did not update in time'
			}
		);

		// Verify the status message
		const statusElement = await $('div.flex-grow p.text-sm');
		const statusMessage = await statusElement.getText();
		expect(statusMessage).toContain('screenpipe is running smoothly');
	});
});
