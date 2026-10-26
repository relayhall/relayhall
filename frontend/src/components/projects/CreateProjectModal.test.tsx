import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { expect, test, vi } from 'vitest';
import { CreateProjectModal } from './CreateProjectModal';

// AZ-A12 clause 10(b) (card 311229fd): the create form's owner selector offers
// Groups only when the page hands it some (root and administrator sessions),
// and passes the chosen Group to the page, which asks for the step-up.
const groups = [
  { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', name: 'Platform team', featured: true },
  { id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', name: 'Research', featured: false },
];
const submit = (tree: ReactTestRenderer) => tree.root.findByType('form').props.onSubmit({ preventDefault: () => undefined });

test('without Groups the create form shows no owner selector and creates as before', async () => {
  const onCreate = vi.fn();
  let tree!: ReactTestRenderer;
  await act(async () => { tree = renderer.create(<CreateProjectModal onClose={vi.fn()} onCreate={onCreate} />); });
  expect(tree.root.findAll(node => node.props.id === 'project-owner-group')).toHaveLength(0);
  await act(async () => { tree.root.findByProps({ id: 'project-name' }).props.onChange({ target: { value: 'Alpha' } }); });
  await act(async () => { submit(tree); });
  expect(onCreate).toHaveBeenCalledWith({ name: 'Alpha', description: undefined, status: 'active' });
  act(() => tree.unmount());
});

test('with Groups the create form offers them and passes the chosen Group as ownerGroupId', async () => {
  const onCreate = vi.fn();
  let tree!: ReactTestRenderer;
  await act(async () => { tree = renderer.create(<CreateProjectModal onClose={vi.fn()} onCreate={onCreate} ownerGroups={groups} />); });
  const select = tree.root.findByProps({ id: 'project-owner-group' });
  expect(select.findAllByType('option').map(option => option.props.value)).toEqual(['', groups[0].id, groups[1].id]);
  await act(async () => { tree.root.findByProps({ id: 'project-name' }).props.onChange({ target: { value: 'Beta' } }); });
  await act(async () => { tree.root.findByProps({ id: 'project-owner-group' }).props.onChange({ target: { value: groups[1].id } }); });
  expect(JSON.stringify(tree.toJSON())).toContain('confirm it is you');
  await act(async () => { submit(tree); });
  expect(onCreate).toHaveBeenCalledWith({ name: 'Beta', description: undefined, status: 'active', ownerGroupId: groups[1].id });
  act(() => tree.unmount());
});

test('a refused Group-owned creation is shown in the form', async () => {
  let tree!: ReactTestRenderer;
  await act(async () => { tree = renderer.create(<CreateProjectModal onClose={vi.fn()} onCreate={vi.fn()} ownerGroups={groups} submitError="Only root or an administrator can do that." />); });
  expect(tree.root.findByProps({ role: 'alert' }).props.children).toBe('Only root or an administrator can do that.');
  act(() => tree.unmount());
});
