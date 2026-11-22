# Publication rules

This supporting file describes the existing publication workflow. Follow
the tool permissions and any required operator approvals.

- The managed `publish(project, title?, description?)` tool publishes one
  checkout and keeps one review request per project. Use the configured
  publication integration for the target repository.
- Every verification command declared for the checkout with `verify` must
  have passed in the isolated executor on the published tree before a
  review request is created or updated.
- Publish only when the user asked for a review request or for changes to
  be published. Never merge.
- Follow-ups reuse the same task branch and review request per project.
  Each turn produces a new verified commit.
