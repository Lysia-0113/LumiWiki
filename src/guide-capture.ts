import type { ScreenshotArtifact } from "./artifacts.js";
import { screenshot, type BrowserSession } from "./browser.js";
import { ensure } from "./config.js";
import type { QuickStartRun } from "./quick-start.js";

type CheckpointResult = Awaited<ReturnType<QuickStartRun["checkpoint"]>>;
type OutcomeResult = Awaited<ReturnType<QuickStartRun["verify"]>>;

// Keep verification and capture in one tool call without weakening the standalone
// screenshot gate. In particular, checkpoints must also reject writes even though
// syncWriteEpoch only revokes outcome evidence.
async function captureVerified(
  browser: BrowserSession,
  run: QuickStartRun,
  evidence: NonNullable<OutcomeResult["evidence"]>,
  writeEpoch: number,
): Promise<ScreenshotArtifact> {
  const assertCurrent = () => {
    run.syncWriteEpoch(browser.writeEpoch);
    ensure(
      browser.writeEpoch === writeEpoch &&
        run.revision === evidence.revision &&
        run.captureEvidenceId() === evidence.id &&
        browser.page.url() === evidence.pageUrl,
      "核验后页面或证据已变化，请重新核验后截图",
    );
  };
  assertCurrent();
  await run.recheck(browser.page);
  assertCurrent();
  const image = await screenshot(browser, evidence.revision, evidence.id);
  // Screenshotting performs async DOM reads and disk writes. A request or UI
  // change during that interval must not turn a stale image into guide evidence.
  await run.recheck(browser.page);
  assertCurrent();
  ensure(image.pageUrl === evidence.pageUrl, "截图页面与核验证据不一致");
  run.capture(image.id, image.revision, image.evidenceId);
  return image;
}

export async function captureCheckpoint(
  browser: BrowserSession,
  run: QuickStartRun,
  checkpointId: string,
): Promise<CheckpointResult & { screenshot?: ScreenshotArtifact }> {
  run.syncWriteEpoch(browser.writeEpoch);
  const writeEpoch = browser.writeEpoch;
  const result = await run.checkpoint(browser.page, checkpointId);
  run.syncWriteEpoch(browser.writeEpoch);
  if (!result.passed) return result;
  const image = await captureVerified(
    browser,
    run,
    result.evidence,
    writeEpoch,
  );
  return { ...result, screenshot: image };
}

export async function captureOutcome(
  browser: BrowserSession,
  run: QuickStartRun,
  outcomeIds?: string[],
): Promise<OutcomeResult & { screenshot?: ScreenshotArtifact }> {
  run.syncWriteEpoch(browser.writeEpoch);
  const writeEpoch = browser.writeEpoch;
  let result = await run.verify(browser.page, outcomeIds);
  run.syncWriteEpoch(browser.writeEpoch);
  // With no explicit group, archive only conditions that actually pass here.
  // Unseen pages remain pending; every declared condition still needs its own proof.
  if (
    outcomeIds === undefined &&
    !result.checks.every((check) => check.passed) &&
    result.availableOutcomeIds.length
  ) {
    result = await run.verify(browser.page, result.availableOutcomeIds);
    run.syncWriteEpoch(browser.writeEpoch);
  }
  if (!result.checks.every((check) => check.passed)) return result;
  ensure(result.evidence, "通过核验后缺少结果证据");
  const image = await captureVerified(
    browser,
    run,
    result.evidence,
    writeEpoch,
  );
  return { ...result, screenshot: image };
}
