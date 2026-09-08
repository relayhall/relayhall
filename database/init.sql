-- RelayHall Database Schema — authoritative fresh-install baseline
-- PostgreSQL 16
--
-- REGENERATED 2026-07-04 from the live dev schema (relayhall-dev-db) via:
--   pg_dump --schema-only --no-owner --no-privileges
-- (cleaned: \restrict guards, search_path unset, extension comments removed)
--
-- This file IS the baseline: it contains the full schema through migration
-- 042_agent_type_provenance_and_retire.sql. On a fresh database:
--   1. apply this file
--   2. run `npm run migrate` — migrate.ts stamps every file listed in
--      backend/src/migrations/BASELINE as applied WITHOUT executing it,
--      then applies only post-baseline (043+) migrations.
-- VOCAB.1 note (task 468faa10): this baseline deliberately keeps the retired
-- agent_types / agent_type_id names. Historical post-baseline migrations
-- (043 backfills from tasks.agent_type_id; 065 alters and seeds agent_types)
-- replay against a fresh database and require the names they were written
-- for; migration 069 then renames everything to the ratified Personality
-- schema at the end of the chain. Renaming the baseline itself would break
-- every fresh install at 043 — do not "fix" these names here.
-- VOCAB.3 note (task daefcdf6): the same doctrine covers the retired
-- tools / project_tools names and their seed rows below. Historical
-- post-baseline migrations 065, 070 and 071 UPDATE tools by those names on
-- replay; migration 072 then renames the registry to the ratified Skills
-- schema, deletes every pre-072 row (owner ruling A14.4) and seeds the
-- curated RelayHall basics. Do not "fix" tools names or seeds here either.
--
-- Do NOT hand-edit table definitions here and in migrations independently;
-- regenerate this file when a new baseline is cut.
-- See backend/src/migrations/README.md for the full migration story.

--
-- PostgreSQL database dump
--


-- Dumped from database version 16.11
-- Dumped by pg_dump version 16.11

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: uuid-ossp; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;


--
-- Name: EXTENSION "uuid-ossp"; Type: COMMENT; Schema: -; Owner: -
--



--
-- Name: update_updated_at_column(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_updated_at_column() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: agent_types; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_types (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    slug character varying(128) NOT NULL,
    name character varying(256) NOT NULL,
    description text,
    category character varying(64),
    color character varying(32),
    content text,
    source_file character varying(512),
    is_custom boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    source text DEFAULT 'legacy-db'::text NOT NULL,
    retired_at timestamp with time zone,
    retired_reason text,
    retired_in_favor_of uuid,
    CONSTRAINT agent_types_source_check CHECK ((source = ANY (ARRAY['git'::text, 'legacy-db'::text])))
);


--
-- Name: agents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agents (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    name character varying(255) NOT NULL,
    status character varying(50) NOT NULL,
    task text,
    spawned_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT agents_status_check CHECK (((status)::text = ANY ((ARRAY['running'::character varying, 'completed'::character varying, 'failed'::character varying])::text[])))
);


--
-- Name: approvals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.approvals (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    type character varying(50) NOT NULL,
    status character varying(50) DEFAULT 'pending'::character varying NOT NULL,
    title character varying(500) NOT NULL,
    description text,
    data jsonb NOT NULL,
    link_token character varying(255) NOT NULL,
    requested_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    responded_at timestamp with time zone,
    response jsonb,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT approvals_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'approved'::character varying, 'denied'::character varying, 'commented'::character varying])::text[]))),
    CONSTRAINT approvals_type_check CHECK (((type)::text = ANY ((ARRAY['command'::character varying, 'plan'::character varying])::text[])))
);


--
-- Name: bot_status; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bot_status (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    mood character varying(100) NOT NULL,
    status_text text NOT NULL,
    avatar_url text,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: TABLE bot_status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.bot_status IS 'Agent avatar and status updates, displayed on dashboard';



--
-- Name: project_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.project_links (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    project_id uuid NOT NULL,
    type character varying(50) NOT NULL,
    title character varying(255) NOT NULL,
    url text NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    category character varying(50),
    CONSTRAINT project_links_category_check CHECK (((category IS NULL) OR ((category)::text = ANY ((ARRAY['repository'::character varying, 'environment'::character varying, 'documentation'::character varying, 'research'::character varying, 'reference'::character varying, 'tool'::character varying])::text[])))),
    CONSTRAINT project_links_type_check CHECK (((type)::text = ANY ((ARRAY['git'::character varying, 'doc'::character varying, 'url'::character varying, 'api'::character varying, 'project'::character varying, 'dashboard'::character varying, 'notebook'::character varying, 'file'::character varying])::text[])))
);


--
-- Name: COLUMN project_links.category; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.project_links.category IS 'Link category: repository, environment, documentation, research, reference, tool';


--
-- Name: project_tools; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.project_tools (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    tool_id uuid NOT NULL,
    override_instructions text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: TABLE project_tools; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.project_tools IS 'Junction table linking tools to projects with optional instruction overrides';


--
-- Name: COLUMN project_tools.override_instructions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.project_tools.override_instructions IS 'When set, replaces the tool base usage_instructions for this project';


--
-- Name: projects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.projects (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    name character varying(255) NOT NULL,
    description text,
    status character varying(50) DEFAULT 'active'::character varying NOT NULL,
    source_dir character varying(255),
    nfs_dir character varying(255),
    is_hidden boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    resources jsonb,
    tool_instructions jsonb,
    CONSTRAINT projects_status_check CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'archived'::character varying])::text[])))
);


--
-- Name: COLUMN projects.resources; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.projects.resources IS 'Structured project resources: repositories, environments, localPaths, notebooks (JSONB)';


--
-- Name: COLUMN projects.tool_instructions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.projects.tool_instructions IS 'Tool-specific instructions for agents: notebooks, file browsing, git workflow, testing, deployment (JSONB)';


--
-- Name: reports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reports (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    title character varying(500) NOT NULL,
    content text NOT NULL,
    summary character varying(500),
    tags text[] DEFAULT '{}'::text[],
    project_id uuid,
    task_ids uuid[] DEFAULT '{}'::uuid[],
    author character varying(100) DEFAULT 'system'::character varying,
    pinned boolean DEFAULT false,
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT reports_status_check CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'archived'::character varying])::text[])))
);


--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_migrations (
    id integer NOT NULL,
    name character varying(255) NOT NULL,
    executed_at timestamp without time zone DEFAULT now()
);


--
-- Name: schema_migrations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.schema_migrations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: schema_migrations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.schema_migrations_id_seq OWNED BY public.schema_migrations.id;


--
-- Name: sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sessions (
    session_key character varying(500) NOT NULL,
    session_id uuid NOT NULL,
    kind character varying(50) DEFAULT 'unknown'::character varying NOT NULL,
    channel character varying(100),
    label character varying(500),
    model character varying(200),
    status character varying(50) DEFAULT 'unknown'::character varying NOT NULL,
    spawn_info jsonb DEFAULT '{}'::jsonb NOT NULL,
    message_count integer DEFAULT 0 NOT NULL,
    tool_call_count integer DEFAULT 0 NOT NULL,
    input_tokens bigint DEFAULT 0 NOT NULL,
    output_tokens bigint DEFAULT 0 NOT NULL,
    thinking_tokens bigint DEFAULT 0 NOT NULL,
    cache_read_tokens bigint DEFAULT 0 NOT NULL,
    total_cost_usd numeric(12,6) DEFAULT 0 NOT NULL,
    started_at timestamp with time zone,
    ended_at timestamp with time zone,
    last_activity_at timestamp with time zone,
    file_size bigint,
    transcript_path character varying(1000),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    agent_type_id uuid,
    backfilled boolean DEFAULT false,
    backfilled_at timestamp with time zone,
    messages_purged boolean DEFAULT false,
    messages_purged_at timestamp with time zone,
    retention_summary jsonb,
    CONSTRAINT sessions_kind_check CHECK (((kind)::text = ANY ((ARRAY['main'::character varying, 'heartbeat'::character varying, 'cron'::character varying, 'subagent'::character varying, 'discord'::character varying, 'acp'::character varying, 'unknown'::character varying])::text[]))),
    CONSTRAINT sessions_status_check CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'completed'::character varying, 'unknown'::character varying])::text[])))
);


--
-- Name: TABLE sessions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.sessions IS 'Dormant session metadata foundation for deployment-neutral reporter ingestion. Core never reads harness runtime files.';


--
-- Name: COLUMN sessions.session_key; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sessions.session_key IS 'Reporter-supplied stable session key (primary lookup).';


--
-- Name: COLUMN sessions.session_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sessions.session_id IS 'UUID from sessions.json. Maps to JSONL filename: <session_id>.jsonl';


--
-- Name: COLUMN sessions.kind; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sessions.kind IS 'Derived from session_key pattern. main/heartbeat/cron/subagent/discord/acp/unknown.';


--
-- Name: COLUMN sessions.channel; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sessions.channel IS 'Messaging surface from sessions.json origin.provider. E.g. discord, telegram.';


--
-- Name: COLUMN sessions.label; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sessions.label IS 'Human-readable label: from sessions.json, JSONL gateway event, or first user message.';


--
-- Name: COLUMN sessions.status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sessions.status IS 'active=in sessions.json, completed=archived, unknown=JSONL-only ingest.';


--
-- Name: COLUMN sessions.spawn_info; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sessions.spawn_info IS 'JSONB: {spawnedBy, spawnDepth, deliveryContext}. Parent session_key, not UUID FK.';


--
-- Name: COLUMN sessions.file_size; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sessions.file_size IS 'JSONL file byte size at last ingest. NULL if file missing.';


--
-- Name: COLUMN sessions.transcript_path; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sessions.transcript_path IS 'Absolute path to JSONL file. Used to locate transcript without sessions.json lookup.';


--
-- Name: COLUMN sessions.backfilled; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sessions.backfilled IS 'True when messages were bulk-ingested from historical JSONL';


--
-- Name: COLUMN sessions.messages_purged; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sessions.messages_purged IS 'True when message content was purged per retention policy';


--
-- Name: COLUMN sessions.retention_summary; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sessions.retention_summary IS 'Summary preserved after message purge: first/last 5 messages + token totals';


--
-- Name: session_aggregate_stats; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.session_aggregate_stats AS
 SELECT count(*) AS total_sessions,
    count(*) FILTER (WHERE ((status)::text = 'running'::text)) AS active_sessions,
    sum(message_count) AS total_messages,
    sum(tool_call_count) AS total_tool_calls,
    sum(((input_tokens + output_tokens) + thinking_tokens)) AS total_tokens,
    sum(total_cost_usd) AS total_cost_usd,
    min(started_at) AS oldest_session,
    max(last_activity_at) AS newest_session,
    count(*) FILTER (WHERE (backfilled = true)) AS backfilled_sessions,
    count(*) FILTER (WHERE (messages_purged = true)) AS purged_sessions
   FROM public.sessions;


--
-- Name: subtasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subtasks (
    id integer NOT NULL,
    task_id uuid NOT NULL,
    index integer NOT NULL,
    title text NOT NULL,
    status character varying(20) DEFAULT 'empty'::character varying NOT NULL,
    note text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    completed_at timestamp with time zone,
    blocked_reason text,
    CONSTRAINT subtasks_status_check CHECK (((status)::text = ANY ((ARRAY['empty'::character varying, 'in-progress'::character varying, 'review'::character varying, 'completed'::character varying, 'stuck'::character varying, 'skipped'::character varying])::text[])))
);


--
-- Name: subtasks_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.subtasks_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: subtasks_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.subtasks_id_seq OWNED BY public.subtasks.id;


--
-- Name: task_dependencies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.task_dependencies (
    task_id uuid NOT NULL,
    depends_on_task_id uuid NOT NULL,
    CONSTRAINT task_dependencies_check CHECK ((task_id <> depends_on_task_id))
);


--
-- Name: task_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.task_history (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    task_id uuid NOT NULL,
    event_type character varying(100) NOT NULL,
    old_value text,
    new_value text,
    note text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    task_title character varying(500)
);


--
-- Name: task_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.task_links (
    id integer NOT NULL,
    task_id uuid NOT NULL,
    type character varying(50) NOT NULL,
    title text NOT NULL,
    url text NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: task_links_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.task_links_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: task_links_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.task_links_id_seq OWNED BY public.task_links.id;


--
-- Name: task_tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.task_tags (
    task_id uuid NOT NULL,
    tag character varying(100) NOT NULL
);


--
-- Name: task_timeline_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.task_timeline_events (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    task_id uuid NOT NULL,
    event_type character varying(100) NOT NULL,
    title text NOT NULL,
    description text,
    session_key text,
    actor character varying(64),
    harness character varying(32),
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tasks (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    title character varying(500) NOT NULL,
    description text,
    status character varying(50) DEFAULT 'todo'::character varying NOT NULL,
    priority character varying(50) DEFAULT 'normal'::character varying,
    tags text[],
    project_id uuid,
    auto_created boolean DEFAULT false,
    auto_start boolean DEFAULT true,
    last_checked timestamp with time zone,
    started_at timestamp with time zone,
    archived_at timestamp with time zone,
    blocked_reason text,
    session_refs jsonb DEFAULT '[]'::jsonb,
    links jsonb DEFAULT '[]'::jsonb,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    agent_type_id uuid,
    thinking_budget character varying(20) DEFAULT 'medium'::character varying,
    thinking_auto_estimated boolean DEFAULT false,
    model character varying(100),
    execution_mode character varying(50),
    execution_profile jsonb,
    status_reason text,
    active_agent jsonb,
    completed_by jsonb,
    attempt_count integer DEFAULT 0,
    parent_id uuid,
    completed_at timestamp with time zone,
    acp_session_key text,
    discord_thread_id text,
    success_criteria text,
    review_history jsonb DEFAULT '[]'::jsonb,
    max_retries integer DEFAULT 3,
    review_status character varying(50) DEFAULT 'pending'::character varying,
    reviewer_session_key text,
    reviewer_last_run_at timestamp with time zone,
    reviewer_timeout_seconds integer DEFAULT 300,
    definition_of_done jsonb,
    constraints jsonb,
    last_reviewed_at timestamp without time zone,
    needs_review boolean DEFAULT false NOT NULL,
    archive_disposition text,
    notes text,
    CONSTRAINT tasks_archive_disposition_check CHECK (((archive_disposition IS NULL) OR (archive_disposition = ANY (ARRAY['completed'::text, 'abandoned'::text])))),
    CONSTRAINT tasks_max_retries_nonnegative CHECK ((max_retries >= 0)),
    CONSTRAINT tasks_priority_check CHECK (((priority)::text = ANY ((ARRAY['urgent'::character varying, 'high'::character varying, 'normal'::character varying, 'low'::character varying, 'someday'::character varying])::text[]))),
    CONSTRAINT tasks_review_status_check CHECK (((review_status)::text = ANY ((ARRAY['pending'::character varying, 'review_in_progress'::character varying, 'needs_human_review'::character varying, 'approved'::character varying, 'rejected'::character varying])::text[]))),
    CONSTRAINT tasks_status_check CHECK (((status)::text = ANY ((ARRAY['ideas'::character varying, 'todo'::character varying, 'in-progress'::character varying, 'review'::character varying, 'stuck'::character varying, 'completed'::character varying, 'archived'::character varying])::text[])))
);


--
-- Name: COLUMN tasks.execution_profile; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.tasks.execution_profile IS 'Structured execution profile for agent spawn policy: mode, accessProfile, requiredCapabilities, override rules, notes.';


--
-- Name: COLUMN tasks.acp_session_key; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.tasks.acp_session_key IS 'Legacy external interactive-session correlation key';


--
-- Name: COLUMN tasks.discord_thread_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.tasks.discord_thread_id IS 'Discord thread ID created for interactive agent sessions (Phase 3: thread auto-creation)';


--
-- Name: COLUMN tasks.success_criteria; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.tasks.success_criteria IS 'Explicit automated Verifier success criteria / acceptance checklist. Supports string or array payloads.';


--
-- Name: COLUMN tasks.review_history; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.tasks.review_history IS 'Structured automated Verifier audit trail including findings, evidence, and pass/reject/escalate outcomes.';


--
-- Name: COLUMN tasks.max_retries; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.tasks.max_retries IS 'Maximum automated Verifier rejection cycles before escalating to a human/operator.';


--
-- Name: COLUMN tasks.review_status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.tasks.review_status IS 'Automated review lifecycle: pending, in_progress, approved, rejected, needs_human_review, timeout.';


--
-- Name: COLUMN tasks.definition_of_done; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.tasks.definition_of_done IS 'Explicit definition of done / acceptance criteria for agent prompts. Supports string or array payloads.';


--
-- Name: COLUMN tasks.constraints; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.tasks.constraints IS 'Explicit task constraints / guardrails for agent prompts. Supports string or array payloads.';


--
-- Name: COLUMN tasks.last_reviewed_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.tasks.last_reviewed_at IS 'Timestamp of the latest completed automated review attempt.';


--
-- Name: COLUMN tasks.needs_review; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.tasks.needs_review IS 'Fast task-level flag for review queues and UI badges. Usually true while a task is awaiting human or automated review.';


--
-- Name: thoughts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.thoughts (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    agent_id uuid,
    task_id uuid,
    entry_type character varying(100) NOT NULL,
    content text NOT NULL,
    metadata jsonb,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: tools; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tools (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(255) NOT NULL,
    category character varying(100),
    description text,
    usage_instructions text,
    config jsonb DEFAULT '{}'::jsonb,
    tags text[] DEFAULT '{}'::text[],
    is_global boolean DEFAULT false,
    version integer DEFAULT 1,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: TABLE tools; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.tools IS 'Registry of tools available to agents and projects';


--
-- Name: COLUMN tools.config; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.tools.config IS 'JSONB config - encrypted at app level for sensitive values';


--
-- Name: COLUMN tools.tags; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.tools.tags IS 'Array of tags for filtering and categorization';


--
-- Name: COLUMN tools.is_global; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.tools.is_global IS 'Global tools are available to all projects';


--
-- Name: COLUMN tools.version; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.tools.version IS 'Auto-incremented on each update';


--
-- Name: transcript_ingester_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transcript_ingester_state (
    session_key character varying(255) NOT NULL,
    bytes_read bigint DEFAULT 0 NOT NULL,
    line_count integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE transcript_ingester_state; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.transcript_ingester_state IS 'Persists TranscriptIngester byte offsets so live watchers resume from last position after restart.';


--
-- Name: COLUMN transcript_ingester_state.bytes_read; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.transcript_ingester_state.bytes_read IS 'Byte offset in the JSONL file up to which we have already ingested.';


--
-- Name: COLUMN transcript_ingester_state.line_count; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.transcript_ingester_state.line_count IS 'Number of JSONL lines read so far (used as base ordinal for new messages).';


--
-- Name: user_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_preferences (
    key text NOT NULL,
    value text NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: TABLE user_preferences; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.user_preferences IS 'Dashboard settings and user preferences';


--
-- Name: schema_migrations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations ALTER COLUMN id SET DEFAULT nextval('public.schema_migrations_id_seq'::regclass);


--
-- Name: subtasks id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subtasks ALTER COLUMN id SET DEFAULT nextval('public.subtasks_id_seq'::regclass);


--
-- Name: task_links id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_links ALTER COLUMN id SET DEFAULT nextval('public.task_links_id_seq'::regclass);


--
-- Name: agent_types agent_types_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_types
    ADD CONSTRAINT agent_types_pkey PRIMARY KEY (id);


--
-- Name: agent_types agent_types_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_types
    ADD CONSTRAINT agent_types_slug_key UNIQUE (slug);


--
-- Name: agents agents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agents
    ADD CONSTRAINT agents_pkey PRIMARY KEY (id);


--
-- Name: approvals approvals_link_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approvals
    ADD CONSTRAINT approvals_link_token_key UNIQUE (link_token);


--
-- Name: approvals approvals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approvals
    ADD CONSTRAINT approvals_pkey PRIMARY KEY (id);


--
-- Name: bot_status bot_status_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bot_status
    ADD CONSTRAINT bot_status_pkey PRIMARY KEY (id);



--
-- Name: project_links project_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_links
    ADD CONSTRAINT project_links_pkey PRIMARY KEY (id);


--
-- Name: project_tools project_tools_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_tools
    ADD CONSTRAINT project_tools_pkey PRIMARY KEY (id);


--
-- Name: project_tools project_tools_project_id_tool_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_tools
    ADD CONSTRAINT project_tools_project_id_tool_id_key UNIQUE (project_id, tool_id);


--
-- Name: projects projects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_pkey PRIMARY KEY (id);


--
-- Name: reports reports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reports
    ADD CONSTRAINT reports_pkey PRIMARY KEY (id);


--
-- Name: schema_migrations schema_migrations_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_name_key UNIQUE (name);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (id);


--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (session_key);


--
-- Name: subtasks subtasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subtasks
    ADD CONSTRAINT subtasks_pkey PRIMARY KEY (id);


--
-- Name: subtasks subtasks_task_id_index_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subtasks
    ADD CONSTRAINT subtasks_task_id_index_key UNIQUE (task_id, index);


--
-- Name: task_dependencies task_dependencies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_dependencies
    ADD CONSTRAINT task_dependencies_pkey PRIMARY KEY (task_id, depends_on_task_id);


--
-- Name: task_history task_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_history
    ADD CONSTRAINT task_history_pkey PRIMARY KEY (id);


--
-- Name: task_links task_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_links
    ADD CONSTRAINT task_links_pkey PRIMARY KEY (id);


--
-- Name: task_tags task_tags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_tags
    ADD CONSTRAINT task_tags_pkey PRIMARY KEY (task_id, tag);


--
-- Name: task_timeline_events task_timeline_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_timeline_events
    ADD CONSTRAINT task_timeline_events_pkey PRIMARY KEY (id);


--
-- Name: tasks tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_pkey PRIMARY KEY (id);


--
-- Name: thoughts thoughts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.thoughts
    ADD CONSTRAINT thoughts_pkey PRIMARY KEY (id);


--
-- Name: tools tools_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tools
    ADD CONSTRAINT tools_name_key UNIQUE (name);


--
-- Name: tools tools_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tools
    ADD CONSTRAINT tools_pkey PRIMARY KEY (id);


--
-- Name: transcript_ingester_state transcript_ingester_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transcript_ingester_state
    ADD CONSTRAINT transcript_ingester_state_pkey PRIMARY KEY (session_key);


--
-- Name: user_preferences user_preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_preferences
    ADD CONSTRAINT user_preferences_pkey PRIMARY KEY (key);


--
-- Name: idx_agent_types_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_types_category ON public.agent_types USING btree (category);


--
-- Name: idx_agent_types_live; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_types_live ON public.agent_types USING btree (category, name) WHERE (retired_at IS NULL);


--
-- Name: idx_agent_types_slug; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_types_slug ON public.agent_types USING btree (slug);


--
-- Name: idx_agents_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agents_status ON public.agents USING btree (status);


--
-- Name: idx_approvals_link_token; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_approvals_link_token ON public.approvals USING btree (link_token);


--
-- Name: idx_approvals_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_approvals_status ON public.approvals USING btree (status);


--
-- Name: idx_bot_status_updated_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bot_status_updated_at ON public.bot_status USING btree (updated_at DESC);



--
-- Name: idx_project_links_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_project_links_category ON public.project_links USING btree (category);


--
-- Name: idx_project_links_project_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_project_links_project_id ON public.project_links USING btree (project_id);


--
-- Name: idx_project_tools_project_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_project_tools_project_id ON public.project_tools USING btree (project_id);


--
-- Name: idx_project_tools_tool_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_project_tools_tool_id ON public.project_tools USING btree (tool_id);


--
-- Name: idx_projects_is_hidden; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_projects_is_hidden ON public.projects USING btree (is_hidden);


--
-- Name: idx_projects_nfs_dir; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_projects_nfs_dir ON public.projects USING btree (nfs_dir);


--
-- Name: idx_projects_resources; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_projects_resources ON public.projects USING gin (resources);


--
-- Name: idx_projects_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_projects_status ON public.projects USING btree (status);


--
-- Name: idx_projects_tool_instructions; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_projects_tool_instructions ON public.projects USING gin (tool_instructions);


--
-- Name: idx_reports_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reports_created_at ON public.reports USING btree (created_at DESC);


--
-- Name: idx_reports_pinned; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reports_pinned ON public.reports USING btree (pinned) WHERE (pinned = true);


--
-- Name: idx_reports_project_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reports_project_id ON public.reports USING btree (project_id);


--
-- Name: idx_reports_tags; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reports_tags ON public.reports USING gin (tags);


--
-- Name: idx_sessions_agent_type_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sessions_agent_type_id ON public.sessions USING btree (agent_type_id);


--
-- Name: idx_sessions_channel; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sessions_channel ON public.sessions USING btree (channel);


--
-- Name: idx_sessions_kind; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sessions_kind ON public.sessions USING btree (kind);


--
-- Name: idx_sessions_label_text; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sessions_label_text ON public.sessions USING gin (to_tsvector('english'::regconfig, (COALESCE(label, ''::character varying))::text));


--
-- Name: idx_sessions_last_activity_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sessions_last_activity_at ON public.sessions USING btree (last_activity_at DESC NULLS LAST);


--
-- Name: idx_sessions_model; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sessions_model ON public.sessions USING btree (model);


--
-- Name: idx_sessions_spawned_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sessions_spawned_by ON public.sessions USING btree (((spawn_info ->> 'spawnedBy'::text)));


--
-- Name: idx_sessions_started_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sessions_started_at ON public.sessions USING btree (started_at DESC NULLS LAST);


--
-- Name: idx_sessions_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sessions_status ON public.sessions USING btree (status);


--
-- Name: idx_task_history_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_task_history_created_at ON public.task_history USING btree (created_at DESC);


--
-- Name: idx_task_history_task_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_task_history_task_id ON public.task_history USING btree (task_id);


--
-- Name: idx_task_timeline_events_session_key; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_task_timeline_events_session_key ON public.task_timeline_events USING btree (session_key) WHERE (session_key IS NOT NULL);


--
-- Name: idx_task_timeline_events_task_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_task_timeline_events_task_created ON public.task_timeline_events USING btree (task_id, created_at DESC);


--
-- Name: idx_tasks_acp_session_key; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tasks_acp_session_key ON public.tasks USING btree (acp_session_key) WHERE (acp_session_key IS NOT NULL);


--
-- Name: idx_tasks_agent_type_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tasks_agent_type_id ON public.tasks USING btree (agent_type_id);


--
-- Name: idx_tasks_auto_start; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tasks_auto_start ON public.tasks USING btree (auto_start, status) WHERE ((auto_start = true) AND ((status)::text = 'todo'::text));


--
-- Name: idx_tasks_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tasks_created_at ON public.tasks USING btree (created_at DESC);


--
-- Name: idx_tasks_discord_thread_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tasks_discord_thread_id ON public.tasks USING btree (discord_thread_id) WHERE (discord_thread_id IS NOT NULL);


--
-- Name: idx_tasks_execution_profile; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tasks_execution_profile ON public.tasks USING gin (execution_profile) WHERE (execution_profile IS NOT NULL);


--
-- Name: idx_tasks_last_reviewed_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tasks_last_reviewed_at ON public.tasks USING btree (last_reviewed_at DESC);


--
-- Name: idx_tasks_links; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tasks_links ON public.tasks USING gin (links);


--
-- Name: idx_tasks_project_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tasks_project_id ON public.tasks USING btree (project_id);


--
-- Name: idx_tasks_review_history; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tasks_review_history ON public.tasks USING gin (review_history);


--
-- Name: idx_tasks_review_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tasks_review_status ON public.tasks USING btree (review_status);


--
-- Name: idx_tasks_session_refs; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tasks_session_refs ON public.tasks USING gin (session_refs);


--
-- Name: idx_tasks_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tasks_status ON public.tasks USING btree (status);


--
-- Name: idx_thoughts_agent_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_thoughts_agent_id ON public.thoughts USING btree (agent_id);


--
-- Name: idx_thoughts_task_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_thoughts_task_id ON public.thoughts USING btree (task_id);


--
-- Name: idx_tools_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tools_category ON public.tools USING btree (category);


--
-- Name: idx_tools_is_global; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tools_is_global ON public.tools USING btree (is_global);


--
-- Name: idx_tools_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tools_name ON public.tools USING btree (name);


--
-- Name: idx_tools_tags; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tools_tags ON public.tools USING gin (tags);


--
-- Name: sessions trg_sessions_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_sessions_updated_at BEFORE UPDATE ON public.sessions FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: agents update_agents_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_agents_updated_at BEFORE UPDATE ON public.agents FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: approvals update_approvals_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_approvals_updated_at BEFORE UPDATE ON public.approvals FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: projects update_projects_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_projects_updated_at BEFORE UPDATE ON public.projects FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: tasks update_tasks_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_tasks_updated_at BEFORE UPDATE ON public.tasks FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: agent_types agent_types_retired_in_favor_of_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_types
    ADD CONSTRAINT agent_types_retired_in_favor_of_fkey FOREIGN KEY (retired_in_favor_of) REFERENCES public.agent_types(id) ON DELETE SET NULL;


--
-- Name: project_links project_links_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_links
    ADD CONSTRAINT project_links_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: project_tools project_tools_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_tools
    ADD CONSTRAINT project_tools_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: project_tools project_tools_tool_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_tools
    ADD CONSTRAINT project_tools_tool_id_fkey FOREIGN KEY (tool_id) REFERENCES public.tools(id) ON DELETE CASCADE;


--
-- Name: reports reports_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reports
    ADD CONSTRAINT reports_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE SET NULL;


--
-- Name: sessions sessions_agent_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_agent_type_id_fkey FOREIGN KEY (agent_type_id) REFERENCES public.agent_types(id) ON DELETE SET NULL;


--
-- Name: subtasks subtasks_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subtasks
    ADD CONSTRAINT subtasks_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.tasks(id) ON DELETE CASCADE;


--
-- Name: task_dependencies task_dependencies_depends_on_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_dependencies
    ADD CONSTRAINT task_dependencies_depends_on_task_id_fkey FOREIGN KEY (depends_on_task_id) REFERENCES public.tasks(id) ON DELETE CASCADE;


--
-- Name: task_dependencies task_dependencies_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_dependencies
    ADD CONSTRAINT task_dependencies_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.tasks(id) ON DELETE CASCADE;


--
-- Name: task_history task_history_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_history
    ADD CONSTRAINT task_history_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.tasks(id) ON DELETE CASCADE;


--
-- Name: task_links task_links_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_links
    ADD CONSTRAINT task_links_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.tasks(id) ON DELETE CASCADE;


--
-- Name: task_tags task_tags_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_tags
    ADD CONSTRAINT task_tags_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.tasks(id) ON DELETE CASCADE;


--
-- Name: task_timeline_events task_timeline_events_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_timeline_events
    ADD CONSTRAINT task_timeline_events_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.tasks(id) ON DELETE CASCADE;


--
-- Name: tasks tasks_agent_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_agent_type_id_fkey FOREIGN KEY (agent_type_id) REFERENCES public.agent_types(id) ON DELETE SET NULL;


--
-- Name: tasks tasks_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE SET NULL;


--
-- Name: thoughts thoughts_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.thoughts
    ADD CONSTRAINT thoughts_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE SET NULL;


--
-- Name: thoughts thoughts_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.thoughts
    ADD CONSTRAINT thoughts_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.tasks(id) ON DELETE SET NULL;


--
-- PostgreSQL database dump complete
--



-- =====================================================
-- INITIAL DATA (preserved seed section)
-- =====================================================

SET search_path TO public;

-- Insert default bot status
INSERT INTO bot_status (mood, status_text, avatar_url)
VALUES ('neutral', 'Ready for work', NULL)
ON CONFLICT DO NOTHING;

-- Seed generic RelayHall tools
INSERT INTO tools (id, name, category, description, usage_instructions, tags, is_global, version)
VALUES
  (
    gen_random_uuid(),
    'task-management',
    'workflow',
    'Manage tasks through the RelayHall API or CLI.',
    E'Use `relayhall list`, `relayhall get`, `relayhall create`, and `relayhall move` for the task lifecycle. Agents start a subtask, hand it to review, and an independent Verifier approves or rejects it. RelayHall compiles prompts with `relayhall prompt`; it never executes an agent.',
    ARRAY['cli', 'tasks', 'workflow'],
    TRUE,
    1
  ),
  (
    gen_random_uuid(),
    'project-management',
    'workflow',
    'Group related tasks, reports, links, and resources into projects.',
    E'Use `relayhall projects`, `relayhall project create`, and the project link/resource commands. Prefer stable URLs and deployment-neutral paths in shared project metadata.',
    ARRAY['cli', 'projects', 'workflow'],
    TRUE,
    1
  ),
  (
    gen_random_uuid(),
    'api-access',
    'automation',
    'Drive RelayHall through its authenticated REST and OpenAPI surfaces.',
    E'Fetch `GET /openapi.json` with an authenticated reader credential. Use principal-bound `rh_` keys with the narrowest required scopes. Unmapped scoped-key routes fail closed to `root`.',
    ARRAY['api', 'openapi', 'automation', 'security'],
    TRUE,
    1
  ),
  (
    gen_random_uuid(),
    'tool-management',
    'admin',
    'Manage the RelayHall tools registry.',
    E'Use `relayhall tools list`, `relayhall tools get <name>`, and `relayhall tools update`. Tool instructions are registry data; update the source record before regenerating derived documentation.',
    ARRAY['admin', 'tools', 'registry'],
    TRUE,
    1
  )
ON CONFLICT (name) DO NOTHING;

-- Schema initialization complete
SELECT 'RelayHall database schema initialized successfully' AS status;
