/**
 * Minimal React fiber node shape used when walking a form element's internals.
 * React does not publish types for its internals; this captures the subset we
 * read when extracting react-final-form / formik APIs off a DOM element.
 */
export type ReactFiberNode = {
  memoizedProps?: Record<string, unknown> & {
    onSubmit?: unknown;
    form?: unknown;
    formApi?: unknown;
    finalFormInstanceHolder?: unknown;
    render?: unknown;
    children?: unknown;
  };
  memoizedState?: Record<string, unknown> | null;
  stateNode?: Record<string, unknown> & { form?: unknown };
  type?: { displayName?: string; name?: string } | string | null;
  return?: ReactFiberNode | null;
  child?: ReactFiberNode | null;
  sibling?: ReactFiberNode | null;
};
