WITH deleted AS (SELECT entity_version,payload_json FROM changes
      WHERE entity_id=?2 AND operation='task.deleted' ORDER BY change_seq DESC LIMIT 1),
    historical_source AS (SELECT
      coalesce(json_extract(payload_json,'$.task.source.integrationKind'),json_extract(payload_json,'$.source.integrationKind')) AS integration_kind,
      coalesce(json_extract(payload_json,'$.task.source.externalIdHash'),json_extract(payload_json,'$.source.externalIdHash')) AS external_id_hash
      FROM changes WHERE entity_id=?2 AND coalesce(json_extract(payload_json,'$.task.source.integrationKind'),json_extract(payload_json,'$.source.integrationKind')) IS NOT NULL
      ORDER BY change_seq DESC LIMIT 1)
    INSERT INTO changes(change_seq,protocol_version,product,mutation_id,operation,entity_kind,
    entity_id,entity_version,payload_json,server_accepted_at)
    SELECT cs.next_change_seq+1,1,'tasks',?1,
      CASE WHEN t.id IS NOT NULL AND t.deleted_at IS NULL THEN 'task.updatedOpenzaFields' ELSE 'task.deleted' END,'task',
      CASE WHEN t.id IS NOT NULL OR d.entity_version IS NOT NULL THEN ?2 ELSE NULL END,
      CASE WHEN (CASE WHEN t.id IS NULL THEN hs.integration_kind ELSE s.integration_kind END)=?4
        AND (CASE WHEN t.id IS NULL THEN hs.external_id_hash ELSE s.external_id_hash END)=?5
        THEN coalesce(t.entity_version,d.entity_version) ELSE NULL END,
      CASE WHEN t.id IS NOT NULL AND t.deleted_at IS NULL THEN json_object('task',json_object('id',t.id,'source',json_object(
        'integrationKind',s.integration_kind,'externalIdHash',s.external_id_hash,'sourceUrl',s.source_url,
        'title',s.source_title,'description',s.source_description,'projectName',s.source_project_name,
        'priority',s.source_priority,'plannedOn',s.source_planned_on,'plannedAt',s.source_planned_at,
        'deadlineOn',s.source_deadline_on,'deadlineAt',s.source_deadline_at,'recurrenceRule',s.recurrence_rule,
        'refreshedAt',s.refreshed_at))) ELSE json_object('task',json_object('id',?2,'deletedAt',
          coalesce(t.deleted_at,json_extract(d.payload_json,'$.task.deletedAt')))) END,?3
    FROM cloud_state cs LEFT JOIN tasks t ON t.id=?2 LEFT JOIN source_descriptors s ON s.task_id=t.id
      LEFT JOIN deleted d ON 1=1 LEFT JOIN historical_source hs ON t.id IS NULL
    WHERE cs.singleton=1
