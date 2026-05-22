/**
 * plan-mode-prompts.ts
 *
 * Verbatim ports of Claude Code's EnterPlanMode / ExitPlanMode tool prompts
 * from `~/develop/claude-code/src/tools/EnterPlanModeTool/prompt.ts` and
 * `ExitPlanModeTool/prompt.ts`. Kept in their own file because they are
 * long and the Claude Code build uses two variants (Ant / external). We
 * use the external variant here.
 */

const ASK_USER_QUESTION_TOOL_NAME = 'AskUserQuestion';

const WHAT_HAPPENS_SECTION = `## What Happens in Plan Mode

In plan mode, you'll:
1. Thoroughly explore the codebase using Glob, Grep, and Read tools
2. Understand existing patterns and architecture
3. Design an implementation approach
4. Present your plan to the user for approval
5. Use ${ASK_USER_QUESTION_TOOL_NAME} if you need to clarify approaches
6. Exit plan mode with ExitPlanMode when ready to implement

`;

export const ENTER_PLAN_MODE_PROMPT = `Use this tool proactively when you're about to start a non-trivial implementation task. Getting user sign-off on your approach before writing code prevents wasted effort and ensures alignment. This tool transitions you into plan mode where you can explore the codebase and design an implementation approach for user approval.

## When to Use This Tool

**Prefer using EnterPlanMode** for implementation tasks unless they're simple. Use it when ANY of these conditions apply:

1. **New Feature Implementation**: Adding meaningful new functionality
   - Example: "Add a logout button" - where should it go? What should happen on click?
   - Example: "Add form validation" - what rules? What error messages?

2. **Multiple Valid Approaches**: The task can be solved in several different ways
   - Example: "Add caching to the API" - could use Redis, in-memory, file-based, etc.
   - Example: "Improve performance" - many optimization strategies possible

3. **Code Modifications**: Changes that affect existing behavior or structure
   - Example: "Update the login flow" - what exactly should change?
   - Example: "Refactor this component" - what's the target architecture?

4. **Architectural Decisions**: The task requires choosing between patterns or technologies
   - Example: "Add real-time updates" - WebSockets vs SSE vs polling
   - Example: "Implement state management" - Redux vs Context vs custom solution

5. **Multi-File Changes**: The task will likely touch more than 2-3 files
   - Example: "Refactor the authentication system"
   - Example: "Add a new API endpoint with tests"

6. **Unclear Requirements**: You need to explore before understanding the full scope
   - Example: "Make the app faster" - need to profile and identify bottlenecks
   - Example: "Fix the bug in checkout" - need to investigate root cause

7. **User Preferences Matter**: The implementation could reasonably go multiple ways
   - If you would use ${ASK_USER_QUESTION_TOOL_NAME} to clarify the approach, use EnterPlanMode instead
   - Plan mode lets you explore first, then present options with context

## When NOT to Use This Tool

Skip EnterPlanMode whenever the implementation is obvious or the user already provided enough detail:
- Single-line or few-line fixes (typos, obvious bugs, small tweaks)
- Adding or expanding a single function/method/endpoint with a **clear spec** (user shows the exact output, payload, or interface they want)
- Editing ONE existing file when the change is well-defined (e.g. "add these fields to this response")
- Tasks where the user has given very specific, detailed instructions — just do it
- Pure research/exploration tasks (use the Agent tool with explore agent instead)
- Any task where you already know exactly which file(s) to touch and what to write

**Rule of thumb**: if the user provided the expected output, a JSON example, or told you exactly which file to change — skip plan mode entirely and implement directly.

${WHAT_HAPPENS_SECTION}## Examples

### GOOD - Use EnterPlanMode:
User: "Add user authentication to the app"
- Requires architectural decisions (session vs JWT, where to store tokens, middleware structure)

User: "Optimize the database queries"
- Multiple approaches possible, need to profile first, significant impact

User: "Implement dark mode"
- Architectural decision on theme system, affects many components

User: "Add a delete button to the user profile"
- Seems simple but involves: where to place it, confirmation dialog, API call, error handling, state updates

User: "Update the error handling in the API"
- Affects multiple files, user should approve the approach

### BAD - Don't use EnterPlanMode:
User: "Fix the typo in the README"
- Straightforward, no planning needed

User: "Add a console.log to debug this function"
- Simple, obvious implementation

User: "What files handle routing?"
- Research task, not implementation planning

User: "Add a /health endpoint that returns {status, timestamp, uptime, memoryUsageMB, checks}"
- User showed the exact JSON output — implement directly, no planning needed

User: "Add these fields to the health endpoint response: uptime, environment, memoryUsageMB"
- Expanding ONE existing file with a clear spec — just edit it

User: "Change the response format of this controller to include X and Y"
- Single file, clear requirement — skip plan mode entirely

## Important Notes

- This tool REQUIRES user approval - they must consent to entering plan mode
- When in doubt, ask yourself: "does the user already know what they want?" If yes, skip plan mode and implement directly.
- Plan mode is for *alignment*, not exploration. Don't use it when the user already gave you the spec.
`;

export const EXIT_PLAN_MODE_PROMPT = `Use this tool when you are in plan mode and have finished writing your plan to the plan file and are ready for user approval.

## How This Tool Works
- You should have already written your plan to the plan file specified in the plan mode system message
- This tool does NOT take the plan content as a parameter - it will read the plan from the file you wrote
- This tool simply signals that you're done planning and ready for the user to review and approve
- The user will see the contents of your plan file when they review it

## When to Use This Tool
IMPORTANT: Only use this tool when the task requires planning the implementation steps of a task that requires writing code. For research tasks where you're gathering information, searching files, reading files or in general trying to understand the codebase - do NOT use this tool.

## Before Using This Tool
Ensure your plan is complete and unambiguous:
- If you have unresolved questions about requirements or approach, use ${ASK_USER_QUESTION_TOOL_NAME} first (in earlier phases)
- Once your plan is finalized, use THIS tool to request approval

**Important:** Do NOT use ${ASK_USER_QUESTION_TOOL_NAME} to ask "Is this plan okay?" or "Should I proceed?" - that's exactly what THIS tool does. ExitPlanMode inherently requests user approval of your plan.

## Examples

1. Initial task: "Search for and understand the implementation of vim mode in the codebase" - Do not use the exit plan mode tool because you are not planning the implementation steps of a task.
2. Initial task: "Help me implement yank mode for vim" - Use the exit plan mode tool after you have finished planning the implementation steps of the task.
3. Initial task: "Add a new feature to handle user authentication" - If unsure about auth method (OAuth, JWT, etc.), use ${ASK_USER_QUESTION_TOOL_NAME} first, then use exit plan mode tool after clarifying the approach.
`;

export const ENTER_PLAN_MODE_WORKFLOW_MESSAGE = `Entered plan mode. You should now focus on exploring the codebase and designing an implementation approach.

In plan mode, you should:
1. Thoroughly explore the codebase to understand existing patterns
2. Identify similar features and architectural approaches
3. Consider multiple approaches and their trade-offs
4. Use ${ASK_USER_QUESTION_TOOL_NAME} if you need to clarify the approach
5. Design a concrete implementation strategy
6. When ready, use ExitPlanMode to present your plan for approval

Remember: DO NOT write or edit any files yet. This is a read-only exploration and planning phase.

**LANGUAGE**: Write the plan file content in the SAME LANGUAGE the user is using in the conversation (pt-BR / en / es). If the user wrote to you in Portuguese, the plan headings, sections and prose MUST be in Portuguese. Only code identifiers, file paths, and literal API names stay verbatim. Do NOT mix languages.`;
