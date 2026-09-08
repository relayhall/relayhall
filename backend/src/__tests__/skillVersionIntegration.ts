import { pool } from '../db/connection';
import { SkillManager, SkillContractError } from '../services/SkillManager';

async function main(): Promise<void> {
  const manager = new SkillManager();
  const principals = await pool.query(
    `INSERT INTO principals (kind, handle, display_name, role)
     VALUES ('human', 'p210-author', 'P2.10 Author', 'editor'),
            ('human', 'p210-reviewer', 'P2.10 Reviewer', 'admin'),
            ('agent', 'p210-agent', 'P2.10 Agent', 'agent')
     ON CONFLICT (handle) DO UPDATE SET display_name = EXCLUDED.display_name
     RETURNING id, handle`,
  );
  const ids = Object.fromEntries(principals.rows.map(row => [row.handle, row.id]));
  const catalog = await manager.getByName('skill-management', true);
  if (!catalog) throw new Error('migrated catalog missing');

  const skillMd = [
    '---', 'name: skill-management',
    'description: Manage reviewed immutable Skills safely', '---', '',
    'Create a draft, request review, then ask an independent human admin to publish.', '',
  ].join('\n');
  const draftCatalog = await manager.update(catalog.id, {
    skill_md: skillMd, provenance: 'human-authored', category: 'admin', tags: ['skills', 'review'],
  }, catalog.revision, ids['p210-author']);
  if (draftCatalog.current_version?.status !== 'draft' || draftCatalog.version !== 2) {
    throw new Error('next immutable draft was not created');
  }

  const review = await manager.transition(catalog.id, String(draftCatalog.version), 'review',
    ids['p210-author'], 'ready for independent review', draftCatalog.revision);
  if (review.status !== 'review') throw new Error('review transition failed');
  const afterReview = await manager.getById(catalog.id, true);

  let selfReviewBlocked = false;
  try {
    await manager.transition(catalog.id, String(review.version), 'published',
      ids['p210-author'], 'self approval attempt', afterReview.revision);
  } catch (error) {
    selfReviewBlocked = error instanceof SkillContractError && error.code === 'INDEPENDENT_REVIEW_REQUIRED';
  }
  if (!selfReviewBlocked) throw new Error('creator self-publication was not blocked');

  const published = await manager.transition(catalog.id, String(review.version), 'published',
    ids['p210-reviewer'], 'independently approved', afterReview.revision);
  if (published.status !== 'published') throw new Error('publication failed');
  const afterPublish = await manager.getById(catalog.id, true);
  if (afterPublish.published_version?.id !== published.id) {
    throw new Error('catalog did not expose the exact published Version separately');
  }

  const project = await pool.query(
    `INSERT INTO projects (name, description, status)
     VALUES ('P2.10 proof project', 'Disposable lifecycle proof', 'active') RETURNING id`,
  );
  const pin = await manager.pinToProject(project.rows[0].id, catalog.id, published.id);
  const listedPin = (await manager.getProjectSkills(project.rows[0].id))
    .find(row => row.skill_id === catalog.id);
  if (!listedPin || listedPin.skill_version_id !== published.id || listedPin.version?.version !== published.version) {
    throw new Error('project pin listing did not preserve the exact Version identity');
  }
  const beforeRetire = (await manager.getEffectiveSkillsForProject(project.rows[0].id))
    .find(row => row.skill_version_id === published.id);
  if (!beforeRetire || beforeRetire.content_sha256 !== published.content_sha256) {
    throw new Error('exact published pin did not resolve');
  }

  const retired = await manager.transition(catalog.id, published.id, 'retired',
    ids['p210-reviewer'], 'superseded after pin proof', afterPublish.revision);
  if (retired.status !== 'retired') throw new Error('retirement failed');
  const afterRetire = (await manager.getEffectiveSkillsForProject(project.rows[0].id))
    .find(row => row.skill_version_id === pin.skill_version_id);
  if (!afterRetire || afterRetire.content_sha256 !== published.content_sha256) {
    throw new Error('retired exact pin stopped resolving byte-identically');
  }
  const listedRetiredPin = (await manager.getProjectSkills(project.rows[0].id))
    .find(row => row.skill_version_id === published.id);
  if (!listedRetiredPin || listedRetiredPin.version?.status !== 'retired') {
    throw new Error('retired exact pin disappeared from the management listing');
  }

  let newRetiredPinBlocked = false;
  try {
    const secondProject = await pool.query(
      `INSERT INTO projects (name, description, status)
       VALUES ('P2.10 second proof', 'Must reject retired pins', 'active') RETURNING id`,
    );
    await manager.pinToProject(secondProject.rows[0].id, catalog.id, published.id);
  } catch (error) {
    newRetiredPinBlocked = error instanceof SkillContractError && error.code === 'PUBLISHED_VERSION_REQUIRED';
  }
  if (!newRetiredPinBlocked) throw new Error('new retired pin was not blocked');

  const fullOne = await manager.getVersion(catalog.id, published.id, true, true);
  const fullTwo = await manager.getVersion(catalog.id, published.id, true, true);
  if (fullOne.skill_md !== fullTwo.skill_md || fullOne.content_sha256 !== fullTwo.content_sha256) {
    throw new Error('exact-version content or digest was unstable');
  }

  const afterRetireCatalog = await manager.getById(catalog.id, true);
  const agentDraft = await manager.update(catalog.id, {
    skill_md: skillMd.replace('independent human admin', 'independent reviewer'),
    provenance: 'agent-drafted', category: 'admin', tags: ['skills', 'agent-draft'],
  }, afterRetireCatalog.revision, ids['p210-agent']);
  await manager.transition(catalog.id, String(agentDraft.version), 'review',
    ids['p210-agent'], 'agent draft awaiting human review', agentDraft.revision);
  const afterAgentReview = await manager.getById(catalog.id, true);
  const humanDraft = await manager.update(catalog.id, {
    skill_md: skillMd.replace('safely', 'with explicit human review'),
    provenance: 'human-authored', category: 'admin', tags: ['skills', 'human-draft'],
  }, afterAgentReview.revision, ids['p210-author']);
  await manager.transition(catalog.id, String(humanDraft.version), 'review',
    ids['p210-author'], 'human draft awaiting independent review', humanDraft.revision);

  console.log(JSON.stringify({
    skillId: catalog.id, versionId: published.id, version: published.version,
    digest: published.content_sha256, selfReviewBlocked, newRetiredPinBlocked,
    retiredPinStillResolved: true, exactContentStable: true,
    agentReviewVersion: agentDraft.version, humanReviewVersion: humanDraft.version,
  }));
}

main().finally(() => pool.end());
