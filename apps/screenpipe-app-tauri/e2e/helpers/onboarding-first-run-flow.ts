// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

export interface OnboardingPermissionFixture {
  isMounted(): Promise<boolean>;
  requiredGrantsComplete(): Promise<boolean>;
  waitForUnmount(): Promise<void>;
}

export async function settleGrantedPermissionStep(driver: OnboardingPermissionFixture): Promise<void> {
  if (await driver.isMounted() && await driver.requiredGrantsComplete()) {
    await driver.waitForUnmount();
  }
}
