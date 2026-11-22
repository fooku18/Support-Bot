---
name: mr-workflow
description: Explains how the managed publisher creates merge or pull requests for task changes. Use for review request and publication questions.
---

# Review request workflow

- Use only the managed `publish(project, title?, description?)` tool.
  It creates or updates one review request per cloned project, targeting
  the branch the checkout was cloned from. Use the configured publication
  integration for that project. On GitLab this is one task MR per project.
  A publisher that supports GitHub would create a pull request. If the
  configured integration cannot publish to the target, report the blocker.
- A thread may change several projects. Clone each with
  `clone_repository(project, ref?)` and publish each checkout separately.
  Follow-ups reuse the same workspace, session, task branch and review
  request per project with a new verified commit.
- Publication requires a verified candidate. Every command declared with
  `verify(project, argv)` must have passed on exactly the tree being published.
- Write to the provider only when the user asked for the relevant action.
  This includes publishing, adding comments, writing issues, updating
  review requests and running pipeline actions. Never push a task branch
  by hand or merge a review request.
- Reply to discovery questions with `ANSWER:` and create no branch, edits
  or review request.

Read [publication rules](references/publication.md) for details.
