import { setupIssues, type SetupIssue } from "@/lib/config";

/**
 * Shown instead of a crash when the deployment is missing configuration. A
 * misconfigured deploy should say what is wrong, not serve a 500.
 */
export default function SetupNotice({ issues }: { issues?: SetupIssue[] }) {
  const problems = issues ?? setupIssues();
  if (problems.length === 0) return null;

  return (
    <div className="setup-notice">
      <h2>This deployment is not fully configured</h2>
      <p className="muted">
        The app is running, but the following environment variables are missing,
        so the features below cannot work yet.
      </p>
      <ul>
        {problems.map((issue) => (
          <li key={issue.envVar}>
            <code>{issue.envVar}</code>
            <p style={{ margin: "0.35rem 0 0" }}>{issue.problem}</p>
            <p className="muted small" style={{ margin: "0.35rem 0 0" }}>
              {issue.fix}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}
