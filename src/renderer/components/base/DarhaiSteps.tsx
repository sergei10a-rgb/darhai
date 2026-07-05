/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { Steps } from '@arco-design/web-react';
import type { StepsProps } from '@arco-design/web-react/es/Steps';
import classNames from 'classnames';
import React from 'react';

/**
 * Steps component props
 */
export interface DarhaiStepsProps extends StepsProps {
  /** Additional class name */
  className?: string;
}

/**
 * Steps component
 *
 * Wrapper around Arco Design Steps with unified theme styling
 *
 * @features
 * - Custom brand color theme
 * - Special styling for finished state
 * - Full Arco Steps API support
 *
 * @example
 * ```tsx
 * // Basic usage
 * <DarhaiSteps current={1}>
 *   <DarhaiSteps.Step title="Step 1" description="Description" />
 *   <DarhaiSteps.Step title="Step 2" description="Description" />
 *   <DarhaiSteps.Step title="Step 3" description="Description" />
 * </DarhaiSteps>
 *
 * // Vertical steps
 * <DarhaiSteps current={1} direction="vertical">
 *   <DarhaiSteps.Step title="Step 1" description="Description" />
 *   <DarhaiSteps.Step title="Step 2" description="Description" />
 * </DarhaiSteps>
 *
 * // Steps with icons
 * <DarhaiSteps current={1}>
 *   <DarhaiSteps.Step title="Done" icon={<IconCheck />} />
 *   <DarhaiSteps.Step title="In progress" icon={<IconLoading />} />
 *   <DarhaiSteps.Step title="Pending" icon={<IconClock />} />
 * </DarhaiSteps>
 *
 * // Mini steps
 * <DarhaiSteps current={1} size="small" type="dot">
 *   <DarhaiSteps.Step title="Step 1" />
 *   <DarhaiSteps.Step title="Step 2" />
 *   <DarhaiSteps.Step title="Step 3" />
 * </DarhaiSteps>
 * ```
 *
 * @see arco-override.css for custom styles (.darhai-steps)
 */
const DarhaiSteps: React.FC<DarhaiStepsProps> & { Step: typeof Steps.Step } = ({ className, ...props }) => {
  return <Steps {...props} className={classNames('darhai-steps', className)} />;
};

DarhaiSteps.displayName = 'DarhaiSteps';

// Export sub-component
DarhaiSteps.Step = Steps.Step;

export default DarhaiSteps;
