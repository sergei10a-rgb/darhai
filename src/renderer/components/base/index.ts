/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Wayland base components unified exports
 *
 * Provides unified export entry for all base components and types
 */

// ==================== Component Exports ====================

export { default as DarhaiModal } from './DarhaiModal';
export { default as DarhaiCollapse } from './DarhaiCollapse';
export { default as DarhaiSelect } from './DarhaiSelect';
export { default as DarhaiScrollArea } from './DarhaiScrollArea';
export { default as DarhaiSteps } from './DarhaiSteps';
export { default as Avatar } from './Avatar';
export type { AvatarProps } from './Avatar';

// ==================== Type Exports ====================

// DarhaiModal types
export type {
  ModalSize,
  ModalHeaderConfig,
  ModalFooterConfig,
  ModalContentStyleConfig,
  DarhaiModalProps,
} from './DarhaiModal';
export { MODAL_SIZES } from './DarhaiModal';

// DarhaiCollapse types
export type { DarhaiCollapseProps, DarhaiCollapseItemProps } from './DarhaiCollapse';

// DarhaiSelect types
export type { DarhaiSelectProps } from './DarhaiSelect';

// DarhaiSteps types
export type { DarhaiStepsProps } from './DarhaiSteps';
