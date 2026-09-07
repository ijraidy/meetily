//! Request handlers for the local sync API (`/api/v1/*`).
//!
//! All responses are JSON with snake_case keys. Errors are `{ "error": "..." }`.

use super::markdown::{extract_summary_markdown, merge_markdown_into_summary};
use super::server::{Ctx, MAX_UPLOAD_BYTES};
use crate::api::MeetingTranscript;
use crate::audio::import;
use crate::database::repositories::{
    meeting::MeetingsRepository, setting::SettingsRepository,
    summary::SummaryProcessesRepository, transcript_chunk::TranscriptChunksRepository,
};
use crate::state::AppState;
use crate::summary;
use axum::{
    extract::{Multipart, Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use chrono::Utc;
use log::{error, info, warn};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::SqlitePool;
use std::collections::HashMap;
use std::path::PathBuf;
use tauri::Manager;
use tokio::io::AsyncWriteExt;

const DEFAULT_TEMPLATE_ID: &str = "meeting_action_plan";
const FALLBACK_TEMPLATE_ID: &str = "daily_standup";
const UPLOAD_DIR: &str = "sync_uploads";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }
    fn bad_request(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, message)
    }
    fn not_found(message: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, message)
    }
    fn conflict(message: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, message)
    }
    fn internal(message: impl Into<String>) -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, message)
    }
    fn unavailable(message: impl Into<String>) -> Self {
        Self::new(StatusCode::SERVICE_UNAVAILABLE, message)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(json!({ "error": self.message }))).into_response()
    }
}

impl From<sqlx::Error> for ApiError {
    fn from(error: sqlx::Error) -> Self {
        match error {
            sqlx::Error::RowNotFound => ApiError::not_found("Meeting not found"),
            other => {
                error!("[sync] database error: {}", other);
                ApiError::internal(format!("Database error: {}", other))
            }
        }
    }
}

type ApiResult<T> = Result<T, ApiError>;

fn pool(ctx: &Ctx) -> ApiResult<SqlitePool> {
    ctx.app
        .try_state::<AppState>()
        .map(|state| state.db_manager.pool().clone())
        .ok_or_else(|| {
            ApiError::unavailable(
                "Database not initialised yet - finish the first-launch setup in the desktop app",
            )
        })
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

struct SummaryRow {
    status: String,
    result: Option<String>,
    error: Option<String>,
}

async fn summary_row(pool: &SqlitePool, meeting_id: &str) -> ApiResult<Option<SummaryRow>> {
    let row: Option<(String, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT status, result, error FROM summary_processes WHERE meeting_id = ?",
    )
    .bind(meeting_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|(status, result, error)| SummaryRow {
        status,
        result,
        error,
    }))
}

/// Maps the stored process status onto the vocabulary exposed by the API.
fn normalise_summary_status(status: &str) -> &'static str {
    match status.to_ascii_lowercase().as_str() {
        "pending" | "processing" => "processing",
        "completed" => "completed",
        "failed" | "error" => "failed",
        "cancelled" | "canceled" => "cancelled",
        _ => "idle",
    }
}

fn sort_transcripts(transcripts: &mut [MeetingTranscript]) {
    transcripts.sort_by(|a, b| {
        match (a.audio_start_time, b.audio_start_time) {
            (Some(x), Some(y)) => x.partial_cmp(&y).unwrap_or(std::cmp::Ordering::Equal),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => std::cmp::Ordering::Equal,
        }
        .then_with(|| a.timestamp.cmp(&b.timestamp))
    });
}

/// Same shape the desktop UI sends to the summary service: `[mm:ss] text` per line.
fn build_transcript_text(transcripts: &[MeetingTranscript]) -> String {
    transcripts
        .iter()
        .map(|t| {
            let stamp = match t.audio_start_time {
                Some(seconds) if seconds.is_finite() && seconds >= 0.0 => {
                    let total = seconds.floor() as u64;
                    format!("[{:02}:{:02}]", total / 60, total % 60)
                }
                _ => t.timestamp.clone(),
            };
            format!("{} {}", stamp, t.text)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn duration_from_transcripts(transcripts: &[MeetingTranscript]) -> Option<f64> {
    transcripts
        .iter()
        .filter_map(|t| {
            t.audio_end_time
                .or_else(|| t.audio_start_time.zip(t.duration).map(|(s, d)| s + d))
        })
        .filter(|v| v.is_finite())
        .fold(None, |acc: Option<f64>, v| Some(acc.map_or(v, |a| a.max(v))))
}

/// Per-meeting summary language: explicit override first, then the cached detection.
async fn meeting_summary_language(pool: &SqlitePool, meeting_id: &str) -> Option<String> {
    let folder = MeetingsRepository::get_meeting_metadata(pool, meeting_id)
        .await
        .ok()
        .flatten()
        .and_then(|meeting| meeting.folder_path)
        .filter(|path| !path.trim().is_empty())
        .map(PathBuf::from)?;
    match summary::metadata::read_summary_language_from_metadata(&folder) {
        Ok(Some(language)) => return Some(language),
        Ok(None) => {}
        Err(e) => warn!("[sync] cannot read summary language for {}: {}", meeting_id, e),
    }
    summary::metadata::read_detected_summary_language_from_metadata(&folder)
        .ok()
        .flatten()
}

fn clean_language(language: Option<String>) -> Option<String> {
    language
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty() && !l.eq_ignore_ascii_case("auto"))
}

// ---------------------------------------------------------------------------
// GET /api/v1/health (no auth)
// ---------------------------------------------------------------------------

pub async fn health(State(ctx): State<Ctx>) -> Json<Value> {
    Json(json!({
        "app": "Minuteman",
        "version": ctx.app.package_info().version.to_string(),
        "auth_required": true,
    }))
}

// ---------------------------------------------------------------------------
// GET /api/v1/meetings
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct MeetingListItem {
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    pub duration_seconds: Option<f64>,
    pub has_summary: bool,
    pub summary_status: &'static str,
}

pub async fn list_meetings(State(ctx): State<Ctx>) -> ApiResult<Json<Vec<MeetingListItem>>> {
    let pool = pool(&ctx)?;
    let meetings = MeetingsRepository::get_meetings(&pool).await?;

    let durations: HashMap<String, Option<f64>> = sqlx::query_as::<_, (String, Option<f64>)>(
        "SELECT meeting_id, MAX(COALESCE(audio_end_time, audio_start_time + duration)) \
         FROM transcripts GROUP BY meeting_id",
    )
    .fetch_all(&pool)
    .await?
    .into_iter()
    .collect();

    let summaries: HashMap<String, (String, Option<String>)> =
        sqlx::query_as::<_, (String, String, Option<String>)>(
            "SELECT meeting_id, status, result FROM summary_processes",
        )
        .fetch_all(&pool)
        .await?
        .into_iter()
        .map(|(id, status, result)| (id, (status, result)))
        .collect();

    let items = meetings
        .into_iter()
        .map(|meeting| {
            let (summary_status, has_summary) = match summaries.get(&meeting.id) {
                Some((status, result)) => (
                    normalise_summary_status(status),
                    result
                        .as_deref()
                        .and_then(extract_summary_markdown)
                        .is_some(),
                ),
                None => ("idle", false),
            };
            MeetingListItem {
                duration_seconds: durations.get(&meeting.id).copied().flatten(),
                id: meeting.id,
                title: meeting.title,
                created_at: meeting.created_at.0.to_rfc3339(),
                updated_at: meeting.updated_at.0.to_rfc3339(),
                has_summary,
                summary_status,
            }
        })
        .collect();

    Ok(Json(items))
}

// ---------------------------------------------------------------------------
// GET /api/v1/meetings/{id}
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct TranscriptItem {
    pub start: Option<f64>,
    pub end: Option<f64>,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speaker: Option<String>,
    pub timestamp: String,
}

#[derive(Debug, Serialize)]
pub struct MeetingDetailResponse {
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    pub duration_seconds: Option<f64>,
    pub transcripts: Vec<TranscriptItem>,
    pub summary_markdown: Option<String>,
    pub summary_language: Option<String>,
    pub summary_status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary_error: Option<String>,
}

pub async fn get_meeting(
    State(ctx): State<Ctx>,
    Path(id): Path<String>,
) -> ApiResult<Json<MeetingDetailResponse>> {
    let pool = pool(&ctx)?;
    let meeting = MeetingsRepository::get_meeting(&pool, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("Meeting not found"))?;

    let mut transcripts = meeting.transcripts;
    sort_transcripts(&mut transcripts);
    let duration_seconds = duration_from_transcripts(&transcripts);

    let (summary_markdown, summary_status, summary_error) =
        match summary_row(&pool, &id).await? {
            Some(row) => {
                let status = normalise_summary_status(&row.status);
                let markdown = row.result.as_deref().and_then(extract_summary_markdown);
                let error = if status == "failed" { row.error } else { None };
                (markdown, status, error)
            }
            None => (None, "idle", None),
        };
    let summary_language = meeting_summary_language(&pool, &id).await;

    Ok(Json(MeetingDetailResponse {
        id: meeting.id,
        title: meeting.title,
        created_at: meeting.created_at,
        updated_at: meeting.updated_at,
        duration_seconds,
        transcripts: transcripts
            .into_iter()
            .map(|t| TranscriptItem {
                start: t.audio_start_time,
                end: t.audio_end_time,
                text: t.text,
                speaker: None,
                timestamp: t.timestamp,
            })
            .collect(),
        summary_markdown,
        summary_language,
        summary_status,
        summary_error,
    }))
}

// ---------------------------------------------------------------------------
// POST /api/v1/meetings (multipart upload -> import job)
// ---------------------------------------------------------------------------

fn sanitise_extension(file_name: Option<&str>) -> Option<String> {
    let name = file_name?;
    let ext = std::path::Path::new(name)
        .extension()
        .and_then(|e| e.to_str())?
        .to_ascii_lowercase();
    if ext.is_empty() || ext.len() > 8 || !ext.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return None;
    }
    Some(ext)
}

fn title_from_file_name(file_name: Option<&str>) -> Option<String> {
    let name = file_name?.trim();
    // `.m4a` has the stem `.m4a` (dot-file semantics): a bare extension is not a title.
    if name.starts_with('.') && !name[1..].contains('.') {
        return None;
    }
    let stem = std::path::Path::new(name)
        .file_stem()
        .and_then(|s| s.to_str())?
        .trim()
        .to_string();
    if stem.is_empty() {
        None
    } else {
        Some(stem)
    }
}

pub async fn upload_meeting(
    State(ctx): State<Ctx>,
    mut multipart: Multipart,
) -> ApiResult<(StatusCode, Json<Value>)> {
    if import::is_import_in_progress() {
        return Err(ApiError::conflict("An import is already in progress"));
    }
    let pool = pool(&ctx)?;

    let upload_dir = ctx
        .app
        .path()
        .app_data_dir()
        .map_err(|e| ApiError::internal(format!("Cannot resolve app data dir: {}", e)))?
        .join(UPLOAD_DIR);
    tokio::fs::create_dir_all(&upload_dir)
        .await
        .map_err(|e| ApiError::internal(format!("Cannot create upload dir: {}", e)))?;

    let mut title: Option<String> = None;
    let mut language: Option<String> = None;
    let mut saved: Option<(PathBuf, Option<String>)> = None;

    loop {
        let field = match multipart.next_field().await {
            Ok(Some(field)) => field,
            Ok(None) => break,
            Err(e) => {
                cleanup_upload(saved.as_ref().map(|(p, _)| p)).await;
                return Err(ApiError::bad_request(format!("Invalid multipart body: {}", e)));
            }
        };
        let name = field.name().map(str::to_string).unwrap_or_default();
        match name.as_str() {
            "title" => {
                title = field
                    .text()
                    .await
                    .ok()
                    .map(|t| t.trim().to_string())
                    .filter(|t| !t.is_empty());
            }
            "language" => {
                language = field.text().await.ok();
            }
            "file" | "audio" => {
                if saved.is_some() {
                    cleanup_upload(saved.as_ref().map(|(p, _)| p)).await;
                    return Err(ApiError::bad_request("Only one file field is allowed"));
                }
                let file_name = field.file_name().map(str::to_string);
                let Some(ext) = sanitise_extension(file_name.as_deref()) else {
                    return Err(ApiError::bad_request(
                        "Upload needs a filename with an audio extension (e.g. recording.m4a)",
                    ));
                };
                if !crate::audio::constants::AUDIO_EXTENSIONS.contains(&ext.as_str()) {
                    return Err(ApiError::bad_request(format!(
                        "Unsupported format: .{}. Supported: {}",
                        ext,
                        crate::audio::constants::AUDIO_EXTENSIONS.join(", ")
                    )));
                }
                let path = upload_dir.join(format!("{}.{}", uuid::Uuid::new_v4(), ext));
                let mut file = tokio::fs::File::create(&path)
                    .await
                    .map_err(|e| ApiError::internal(format!("Cannot create upload file: {}", e)))?;
                let mut written: u64 = 0;
                let mut field = field;
                loop {
                    let chunk = match field.chunk().await {
                        Ok(Some(chunk)) => chunk,
                        Ok(None) => break,
                        Err(e) => {
                            drop(file);
                            cleanup_upload(Some(&path)).await;
                            return Err(ApiError::bad_request(format!(
                                "Upload interrupted: {}",
                                e
                            )));
                        }
                    };
                    written += chunk.len() as u64;
                    if written > MAX_UPLOAD_BYTES {
                        drop(file);
                        cleanup_upload(Some(&path)).await;
                        return Err(ApiError::new(
                            StatusCode::PAYLOAD_TOO_LARGE,
                            "Upload exceeds the 2 GB limit",
                        ));
                    }
                    if let Err(e) = file.write_all(&chunk).await {
                        drop(file);
                        cleanup_upload(Some(&path)).await;
                        return Err(ApiError::internal(format!("Cannot write upload: {}", e)));
                    }
                }
                if let Err(e) = file.flush().await {
                    drop(file);
                    cleanup_upload(Some(&path)).await;
                    return Err(ApiError::internal(format!("Cannot flush upload: {}", e)));
                }
                drop(file);
                if written == 0 {
                    cleanup_upload(Some(&path)).await;
                    return Err(ApiError::bad_request("Uploaded file is empty"));
                }
                info!("[sync] received upload {} ({} bytes)", path.display(), written);
                saved = Some((path, file_name));
            }
            _ => {
                // Drain unknown fields so the stream stays consistent.
                let _ = field.bytes().await;
            }
        }
    }

    let Some((path, file_name)) = saved else {
        return Err(ApiError::bad_request("Missing multipart field 'file'"));
    };

    // Validate through the same checks the desktop import dialog uses.
    let validation_path = path.clone();
    let validation = tokio::task::spawn_blocking(move || import::validate_audio_file(&validation_path))
        .await
        .map_err(|e| ApiError::internal(format!("Validation task failed: {}", e)))?;
    if let Err(e) = validation {
        cleanup_upload(Some(&path)).await;
        return Err(ApiError::bad_request(format!("Invalid audio file: {}", e)));
    }

    let title = title
        .or_else(|| title_from_file_name(file_name.as_deref()))
        .unwrap_or_else(|| format!("Recording {}", Utc::now().format("%Y-%m-%d %H:%M")));

    // Use the transcription model configured in the desktop app.
    let (provider, model) = match SettingsRepository::get_transcript_config(&pool).await {
        Ok(Some(config)) => (config.provider, config.model),
        Ok(None) => (
            "localWhisper".to_string(),
            crate::config::DEFAULT_WHISPER_MODEL.to_string(),
        ),
        Err(e) => {
            cleanup_upload(Some(&path)).await;
            return Err(ApiError::internal(format!("Cannot read transcript config: {}", e)));
        }
    };
    let is_parakeet = provider.eq_ignore_ascii_case("parakeet");
    let language = if is_parakeet {
        None
    } else {
        clean_language(language)
    };

    if import::is_import_in_progress() {
        cleanup_upload(Some(&path)).await;
        return Err(ApiError::conflict("An import is already in progress"));
    }

    let job = ctx.jobs.create(&title);
    info!(
        "[sync] starting import job {} for '{}' (provider={}, model={}, language={:?})",
        job.id, title, provider, model, language
    );

    let app = ctx.app.clone();
    let jobs = ctx.jobs.clone();
    let job_id = job.id.clone();
    let source_path = path.to_string_lossy().to_string();
    let job_title = title.clone();
    tauri::async_runtime::spawn(async move {
        jobs.set_active(&job_id);
        let result = import::start_import(
            app,
            source_path,
            job_title,
            language,
            Some(model),
            Some(provider),
        )
        .await;
        match result {
            Ok(res) => {
                info!("[sync] import job {} finished -> meeting {}", job_id, res.meeting_id);
                jobs.complete(&job_id, res.meeting_id);
            }
            Err(e) => {
                error!("[sync] import job {} failed: {}", job_id, e);
                jobs.fail(&job_id, e.to_string());
            }
        }
        // The pipeline copied the audio into the meeting folder; drop the upload.
        cleanup_upload(Some(&path)).await;
    });

    Ok((
        StatusCode::ACCEPTED,
        Json(json!({
            "id": job.id,
            "status": "processing",
            "title": title,
        })),
    ))
}

async fn cleanup_upload(path: Option<&PathBuf>) {
    if let Some(path) = path {
        if let Err(e) = tokio::fs::remove_file(path).await {
            if e.kind() != std::io::ErrorKind::NotFound {
                warn!("[sync] could not remove upload {}: {}", path.display(), e);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// GET /api/v1/meetings/{id}/status  (job id or meeting id)
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct StatusResponse {
    pub id: String,
    /// "processing" | "ready" | "error"
    pub status: &'static str,
    /// What the status refers to: "import" (upload job) or "summary"/"idle" (meeting).
    pub phase: &'static str,
    pub progress: Option<u32>,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meeting_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary_status: Option<&'static str>,
}

pub async fn get_status(
    State(ctx): State<Ctx>,
    Path(id): Path<String>,
) -> ApiResult<Json<StatusResponse>> {
    if let Some(job) = ctx.jobs.get(&id) {
        let status = match job.status {
            super::jobs::JobStatus::Processing => "processing",
            super::jobs::JobStatus::Ready => "ready",
            super::jobs::JobStatus::Error => "error",
        };
        return Ok(Json(StatusResponse {
            id: job.id,
            status,
            phase: "import",
            progress: Some(job.progress),
            message: job.message,
            meeting_id: job.meeting_id,
            summary_status: None,
        }));
    }

    let pool = pool(&ctx)?;
    MeetingsRepository::get_meeting_metadata(&pool, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("No job or meeting with that id"))?;

    let response = match summary_row(&pool, &id).await? {
        None => StatusResponse {
            id: id.clone(),
            status: "ready",
            phase: "idle",
            progress: None,
            message: "Meeting ready, no summary yet".to_string(),
            meeting_id: Some(id),
            summary_status: Some("idle"),
        },
        Some(row) => {
            let summary_status = normalise_summary_status(&row.status);
            let (status, message) = match summary_status {
                "processing" => ("processing", "Generating summary".to_string()),
                "failed" => (
                    "error",
                    row.error
                        .clone()
                        .unwrap_or_else(|| "Summary generation failed".to_string()),
                ),
                "completed" => ("ready", "Summary ready".to_string()),
                "cancelled" => ("ready", "Summary generation cancelled".to_string()),
                _ => ("ready", "Meeting ready".to_string()),
            };
            StatusResponse {
                id: id.clone(),
                status,
                phase: "summary",
                progress: None,
                message,
                meeting_id: Some(id),
                summary_status: Some(summary_status),
            }
        }
    };
    Ok(Json(response))
}

// ---------------------------------------------------------------------------
// POST /api/v1/meetings/{id}/summary  (trigger generation)
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Deserialize)]
pub struct GenerateSummaryBody {
    pub template_id: Option<String>,
    pub language: Option<String>,
    pub custom_prompt: Option<String>,
}

fn resolve_template_id(requested: Option<String>) -> ApiResult<String> {
    if let Some(id) = requested.map(|t| t.trim().to_string()).filter(|t| !t.is_empty()) {
        return summary::templates::get_template(&id)
            .map(|_| id.clone())
            .map_err(|e| ApiError::bad_request(format!("Unknown template '{}': {}", id, e)));
    }
    if summary::templates::get_template(DEFAULT_TEMPLATE_ID).is_ok() {
        Ok(DEFAULT_TEMPLATE_ID.to_string())
    } else {
        Ok(FALLBACK_TEMPLATE_ID.to_string())
    }
}

pub async fn generate_summary(
    State(ctx): State<Ctx>,
    Path(id): Path<String>,
    body: Option<Json<GenerateSummaryBody>>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let body = body.map(|Json(b)| b).unwrap_or_default();
    let pool = pool(&ctx)?;

    let meeting = MeetingsRepository::get_meeting(&pool, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("Meeting not found"))?;
    let mut transcripts = meeting.transcripts;
    sort_transcripts(&mut transcripts);
    let text = build_transcript_text(&transcripts);
    if text.trim().is_empty() {
        return Err(ApiError::bad_request("Meeting has no transcript to summarise"));
    }

    let model_config = SettingsRepository::get_model_config(&pool)
        .await?
        .ok_or_else(|| {
            ApiError::bad_request(
                "No summary model configured. Choose one under Settings > Summary in the desktop app",
            )
        })?;

    if let Some(row) = summary_row(&pool, &id).await? {
        if normalise_summary_status(&row.status) == "processing" {
            return Err(ApiError::conflict("Summary generation is already in progress"));
        }
    }

    let template_id = resolve_template_id(body.template_id)?;
    let summary_language = match clean_language(body.language) {
        Some(language) => Some(language),
        None => meeting_summary_language(&pool, &id).await,
    };

    info!(
        "[sync] generating summary for {} (provider={}, model={}, template={}, language={:?})",
        id, model_config.provider, model_config.model, template_id, summary_language
    );

    let started = summary::commands::start_summary_generation(
        ctx.app.clone(),
        pool.clone(),
        text,
        model_config.provider,
        model_config.model,
        Some(id.clone()),
        None,
        None,
        body.custom_prompt,
        Some(template_id.clone()),
        summary_language,
    )
    .await
    .map_err(ApiError::internal)?;

    Ok((
        StatusCode::ACCEPTED,
        Json(json!({
            "status": "processing",
            "meeting_id": id,
            "process_id": started.process_id,
            "template_id": template_id,
        })),
    ))
}

// ---------------------------------------------------------------------------
// PUT /api/v1/meetings/{id}/summary  (save markdown)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct SaveSummaryBody {
    pub markdown: String,
}

pub async fn save_summary(
    State(ctx): State<Ctx>,
    Path(id): Path<String>,
    Json(body): Json<SaveSummaryBody>,
) -> ApiResult<Json<Value>> {
    let pool = pool(&ctx)?;
    if body.markdown.trim().is_empty() {
        return Err(ApiError::bad_request("markdown must not be empty"));
    }

    let meeting = MeetingsRepository::get_meeting(&pool, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("Meeting not found"))?;

    let existing = summary_row(&pool, &id).await?;
    let merged = merge_markdown_into_summary(
        existing.as_ref().and_then(|row| row.result.as_deref()),
        &body.markdown,
    );

    match existing {
        Some(row) => {
            let status = normalise_summary_status(&row.status);
            if status == "processing" {
                return Err(ApiError::conflict(
                    "Summary generation is in progress; wait for it to finish or cancel it first",
                ));
            }
            summary::commands::save_meeting_summary(&pool, &id, &merged)
                .await
                .map_err(ApiError::bad_request)?;
            if status != "completed" {
                // A manual save supersedes a failed/cancelled generation.
                sqlx::query(
                    "UPDATE summary_processes SET status = 'completed', error = NULL, \
                     end_time = COALESCE(end_time, ?) WHERE meeting_id = ?",
                )
                .bind(Utc::now())
                .bind(&id)
                .execute(&pool)
                .await?;
            }
        }
        None => {
            // No generation has ever run for this meeting: create the rows the
            // desktop UI expects (summary_processes + transcript_chunks) so the
            // saved summary shows up there too.
            if !summary::commands::summary_is_renderable(&merged) {
                return Err(ApiError::bad_request(
                    "Summary contains no visible content or model reasoning markers and was not saved.",
                ));
            }
            let mut transcripts = meeting.transcripts;
            sort_transcripts(&mut transcripts);
            let text = build_transcript_text(&transcripts);
            let started_at = Utc::now();
            SummaryProcessesRepository::create_or_reset_process(&pool, &id, started_at).await?;
            TranscriptChunksRepository::save_transcript_data(
                &pool, &id, &text, "manual", "manual", 40000, 1000,
            )
            .await?;
            let completed = SummaryProcessesRepository::update_process_completed(
                &pool, &id, started_at, merged, 0, 0.0,
            )
            .await?;
            if !completed {
                return Err(ApiError::internal("Could not store the summary"));
            }
        }
    }

    Ok(Json(json!({ "ok": true })))
}

// ---------------------------------------------------------------------------
// DELETE /api/v1/meetings/{id}
// ---------------------------------------------------------------------------

pub async fn delete_meeting(
    State(ctx): State<Ctx>,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let pool = pool(&ctx)?;
    match MeetingsRepository::delete_meeting(&pool, &id).await? {
        true => {
            info!("[sync] deleted meeting {}", id);
            Ok(Json(json!({ "ok": true })))
        }
        false => Err(ApiError::not_found("Meeting not found")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn transcript(start: Option<f64>, end: Option<f64>, text: &str, ts: &str) -> MeetingTranscript {
        MeetingTranscript {
            id: format!("t-{}", text),
            text: text.to_string(),
            timestamp: ts.to_string(),
            audio_start_time: start,
            audio_end_time: end,
            duration: None,
        }
    }

    #[test]
    fn transcript_text_matches_desktop_format() {
        let mut items = vec![
            transcript(Some(65.9), Some(70.0), "second", "b"),
            transcript(Some(1.0), Some(3.0), "first", "a"),
            transcript(None, None, "no timing", "2024-01-01T00:00:00Z"),
        ];
        sort_transcripts(&mut items);
        assert_eq!(
            build_transcript_text(&items),
            "[00:01] first\n[01:05] second\n2024-01-01T00:00:00Z no timing"
        );
        assert_eq!(duration_from_transcripts(&items), Some(70.0));
    }

    #[test]
    fn summary_status_vocabulary() {
        assert_eq!(normalise_summary_status("PENDING"), "processing");
        assert_eq!(normalise_summary_status("processing"), "processing");
        assert_eq!(normalise_summary_status("completed"), "completed");
        assert_eq!(normalise_summary_status("failed"), "failed");
        assert_eq!(normalise_summary_status("cancelled"), "cancelled");
        assert_eq!(normalise_summary_status("weird"), "idle");
    }

    #[test]
    fn extension_and_title_sanitising() {
        assert_eq!(sanitise_extension(Some("Voice Memo.M4A")).as_deref(), Some("m4a"));
        assert_eq!(sanitise_extension(Some("noext")), None);
        assert_eq!(sanitise_extension(Some("bad.ex t")), None);
        assert_eq!(sanitise_extension(None), None);
        assert_eq!(title_from_file_name(Some("Voice Memo.m4a")).as_deref(), Some("Voice Memo"));
        assert_eq!(title_from_file_name(Some(".m4a")), None);
    }

    #[test]
    fn language_cleaning() {
        assert_eq!(clean_language(Some(" ar ".into())).as_deref(), Some("ar"));
        assert_eq!(clean_language(Some("auto".into())), None);
        assert_eq!(clean_language(Some("".into())), None);
        assert_eq!(clean_language(None), None);
    }
}
