import * as React from 'react';
import { Box, Text } from 'ink';
import { ReplContext } from '../context';

export function Header({ ctx }: { ctx: ReplContext }): React.ReactElement {
  const email = ctx.user?.email || 'not logged in';
  const project = ctx.activeProject?.name || null;
  const model = ctx.providerInfo
    ? `${ctx.providerInfo.provider}/${ctx.providerInfo.model}`
    : ctx.provider;

  // Single compact line — no border. Zero visual weight at the top.
  return (
    <Box>
      <Text bold color="cyan">makestudio</Text>
      <Text color="gray">{' · '}</Text>
      <Text color="blue">{email}</Text>
      {project ? (
        <>
          <Text color="gray">{' · '}</Text>
          <Text color="green">{project}</Text>
        </>
      ) : null}
      <Text color="gray">{' · '}</Text>
      <Text color="yellow">{model}</Text>
      <Text color="gray">{' · '}</Text>
      <Text color="magenta">effort:{ctx.effort}</Text>
    </Box>
  );
}
