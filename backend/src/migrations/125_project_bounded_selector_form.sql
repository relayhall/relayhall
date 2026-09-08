-- 125_project_bounded_selector_form.sql
-- RH-AZ.PROJ-b (card 95572530): the FOURTH selector form on Access profiles.
--
-- AUTHZ design 4d961e37 s4 ratified three forms - 'exact' (pinned ids),
-- 'all-of-type' (every object of the type, future included) and 'all-except'
-- (all-of-type minus a pinned exclusion list). The owner's 2026-09-02 split of
-- card b363a38c charters a fourth for the PROJECT axis: authority bounded to a
-- named set of Projects, future-inclusive INSIDE that perimeter and closed
-- outside it.
--
-- THE NAME. The family's grammar is already load-bearing: `all-` marks the
-- future-inclusive forms and `exact` is the only pinned one. The fourth form is
-- therefore 'all-in-project' - every object of the rule's type in the named
-- Projects, those created later included.
--
-- WHAT `selector_ids` HOLDS. For 'all-in-project' the array holds PROJECT ids,
-- not ids of the rule's own resource type. That is the single respect in which
-- the fourth form differs in kind from the other three, and it is why this
-- migration adds a per-resource-type CHECK rather than only widening the
-- vocabulary: a form whose ids are read against a different table is
-- meaningless on a type with no project coordinate.
--
-- WHY THIS CANNOT WIDEN ANYTHING. Every clause below is additive over the
-- CURRENT contents of `access_profile_rules`:
--   * no existing row carries 'all-in-project' (the pre-125 CHECK made it
--     unrepresentable), so no existing row's meaning changes and no existing
--     row can fail the new constraints;
--   * the shape CHECK below is the old one with one more admitted form, and it
--     now names the admitted forms EXPLICITLY instead of testing
--     `selector_form <> 'all-of-type'` - a fifth form added later fails BOTH
--     branches and is refused until someone decides its shape, rather than
--     inheriting the 'exact' branch by default;
--   * `access_profile_rules_project_bounded_types` is a NEW refusal and adds
--     no permission.
-- A rule of the new form admits a strict subset of what 'all-of-type' admits
-- for the same (resource_type, verbs) pair. It is a narrowing tool: an author
-- who could previously express only "every Task" can now express "every Task
-- in these Projects".
--
-- WHERE THE CLOSURE IS. Three independent halves, each removable without the
-- others failing (the AZ-A5 clause 3 pattern, acceptance annex 85a2218d D3):
--   (a) the WRITE, in SQL: `access_profile_rules_project_bounded_types` below
--       refuses an inadmissible row even for a caller writing raw SQL, which is
--       strictly stronger than the `surface` closure AZ-A5 could reach;
--   (b) the WRITE, in the service: `SELECTOR_FORM_ADMISSIBILITY` in
--       AccessProfileService drives `validateRules` at every write surface, and
--       `assertProjectBoundedSelectors` refuses ids that name no Project;
--   (c) the EVALUATOR: `renderAuthoritySeam` renders the project-bounded arm as
--       the literal FALSE for every resource shape that declares no project
--       coordinate, so such a row changes no decision however it was written.
--
-- WHICH TYPES. 'task' and 'phase'. NOT 'project': a Project's project
-- coordinate is its own id, so the form would be a second spelling of 'exact',
-- and a closed set with two spellings for one authority is what the closed set
-- exists to prevent. NOT the capability-plane or catalogue types, which carry
-- no project coordinate at all; 'surface' remains 'exact'-only (AZ-A5 clause 3,
-- enforced in the service, where the governance row is also read).
--
-- Fresh-replay doctrine: database/init.sql untouched; idempotent.
--
-- ORDERING: this migration depends only on 095. It does not read or alter any
-- other lane's schema, so integrating after a higher-numbered lane is safe
-- (RESERVED ledger, owner ruling PARALLEL-WRITERS 0464ad54 s2).

ALTER TABLE access_profile_rules
  DROP CONSTRAINT IF EXISTS access_profile_rules_selector_form_check;
ALTER TABLE access_profile_rules
  ADD CONSTRAINT access_profile_rules_selector_form_check
  CHECK (selector_form IN ('exact', 'all-of-type', 'all-except', 'all-in-project'));

-- THE EMPTY-ARRAY HOLE, CLOSED (found by this card's live drill).
--
-- 095 wrote the second branch as `array_length(selector_ids, 1) >= 1`. For an
-- EMPTY array `array_length` returns NULL, not 0, so the branch evaluates to
-- NULL, `FALSE OR NULL` is NULL, and a CHECK admits anything that is not
-- FALSE. An empty id list was therefore representable for every form, and for
-- `all-except` that is a WIDENING: `NOT (id = ANY('{}'))` is TRUE for every
-- row, so an exclusion list of nothing silently became `all-of-type`. The
-- validator always refused it, which is why no row has one; the CHECK did not.
--
-- `cardinality` answers 0 for the empty array, so the branch is FALSE and the
-- row is refused. The rewrite is a NARROWING in both directions: it can only
-- refuse rows the old constraint admitted, never admit one it refused.
--
-- The pre-flight below turns what would otherwise be a bare constraint
-- violation into a sentence naming the rows and what to do about them. It
-- cannot fire on a database whose rules were all written through the API.
DO $$
DECLARE offenders TEXT;
BEGIN
  SELECT string_agg(id::text, ', ') INTO offenders
    FROM access_profile_rules
   WHERE NOT (
     (selector_form = 'all-of-type' AND selector_ids = '{}')
     OR (selector_form IN ('exact', 'all-except', 'all-in-project')
         AND cardinality(selector_ids) >= 1)
   );
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION
      '125: access_profile_rules rows carry a selector shape no form admits (an empty id list on a pinned form, or an unknown form): %. They were only ever writable in raw SQL; delete the versions that carry them, or republish those profiles, before migrating.', offenders;
  END IF;
END $$;

ALTER TABLE access_profile_rules
  DROP CONSTRAINT IF EXISTS access_profile_rules_selector_shape;
ALTER TABLE access_profile_rules
  ADD CONSTRAINT access_profile_rules_selector_shape
  CHECK (
    (selector_form = 'all-of-type' AND selector_ids = '{}')
    OR (selector_form IN ('exact', 'all-except', 'all-in-project')
        AND cardinality(selector_ids) >= 1)
  );

-- (a) The write closure, in SQL. `all-in-project` reads its ids against
-- `projects`, so it is admitted only for the types that HAVE a project
-- coordinate. This refuses the row a raw INSERT would otherwise write.
ALTER TABLE access_profile_rules
  DROP CONSTRAINT IF EXISTS access_profile_rules_project_bounded_types;
ALTER TABLE access_profile_rules
  ADD CONSTRAINT access_profile_rules_project_bounded_types
  CHECK (selector_form <> 'all-in-project' OR resource_type IN ('task', 'phase'));

-- THE SELF-CHECK. The two DROPs above name constraints PostgreSQL generated
-- from the column name in 095. If either name were different, `DROP CONSTRAINT
-- IF EXISTS` is a silent no-op, the old three-form CHECK survives, and the
-- feature ships refusing every row it was built to accept - a green migration
-- and a dead feature. So the migration asserts its own postcondition: no CHECK
-- on this table may still enumerate the old vocabulary without the new form.
-- This is the anchor a naming assumption cannot forge.
DO $$
DECLARE stale TEXT;
BEGIN
  SELECT string_agg(conname, ', ') INTO stale
    FROM pg_constraint
   WHERE conrelid = 'access_profile_rules'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%all-except%'
     AND pg_get_constraintdef(oid) NOT LIKE '%all-in-project%';
  IF stale IS NOT NULL THEN
    RAISE EXCEPTION
      '125: a selector-form CHECK survives that still refuses all-in-project: %', stale;
  END IF;
END $$;

COMMENT ON COLUMN access_profile_rules.selector_form IS
  'One of the four ratified selector forms (AUTHZ 4d961e37 s4; fourth added by card 95572530): exact (pinned ids); all-of-type (every object of the type, future included); all-except (all-of-type minus a pinned exclusion list); all-in-project (every object of the type inside the Projects named by selector_ids, future included). The all- prefix marks the future-inclusive forms.';
COMMENT ON COLUMN access_profile_rules.selector_ids IS
  'Object ids of resource_type for exact and all-except; PROJECT ids for all-in-project; empty for all-of-type. The form decides which table the ids are read against.';
COMMENT ON CONSTRAINT access_profile_rules_project_bounded_types ON access_profile_rules IS
  'Card 95572530: all-in-project is admitted only for resource types that carry a project coordinate. project is excluded deliberately - it IS its own project coordinate, so the form would duplicate exact.';
