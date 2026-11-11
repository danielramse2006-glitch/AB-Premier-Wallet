begin;

create table ab_private.wallet_cards (
 client_id bigint primary key references public.clients on delete cascade,
 token uuid not null unique default gen_random_uuid(),
 object_suffix uuid not null unique default gen_random_uuid(),
 revoked boolean not null default false,
 revision bigint not null default 1,
 synced_revision bigint not null default 0,
 lease_until timestamptz
);

create table ab_private.wallet_visit_requests (
 employee_id uuid not null references auth.users on delete cascade,
 request_id uuid not null,
 client_id bigint not null references public.clients on delete cascade,
 selection jsonb not null,
 result jsonb not null,
 primary key (employee_id,request_id)
);

create function ab_private.wallet_snapshot(card ab_private.wallet_cards)
returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object(
  'token',card.token,'object_suffix',card.object_suffix,'revoked',card.revoked,
  'revision',card.revision,'full_name',c.full_name,'visits',v.total,
  'tier',ab_private.membership_tier(v.total),'next_cut',r.cut,'next_prize',r.name,
  'available',(select count(*) from public.courtesies co where co.client_id=c.id and co.status='pending')
 )
 from public.clients c
 cross join lateral (select count(*)::int total from public.visits where client_id=c.id) v
 left join lateral (select cut,name from ab_private.rewards where cut>v.total order by cut limit 1) r on true
 where c.id=card.client_id
$$;

create function public.wallet_staff(action text, p jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 role_name text:=ab_private.staff_role();
 card ab_private.wallet_cards;
 member public.clients;
 result jsonb;
 request_uuid uuid;
 saved ab_private.wallet_visit_requests;
 selection jsonb;
begin
 if role_name is null or role_name not in ('admin','recepcion','barbero') then
  raise exception 'Se requiere una cuenta de personal autorizada.' using errcode='42501';
 end if;
 if action in ('issue','revoke') then
  select * into member from public.clients where id=(p->>'client_id')::bigint;
  if not found then raise exception 'Socio no encontrado.'; end if;
  if action='issue' then
   insert into ab_private.wallet_cards(client_id) values(member.id) on conflict do nothing;
   select * into card from ab_private.wallet_cards where client_id=member.id;
   if card.revoked then
    update ab_private.wallet_cards set revoked=false,revision=revision+1
     where client_id=member.id returning * into card;
   end if;
  else
   update ab_private.wallet_cards set token=gen_random_uuid(),revoked=true,revision=revision+1
    where client_id=member.id returning * into card;
   if not found then raise exception 'Este socio todavía no tiene tarjeta.'; end if;
  end if;
  perform ab_private.audit('wallet_'||action,'client',member.id::text);
  return ab_private.wallet_snapshot(card);
 end if;
 if action not in ('lookup','visit') then raise exception 'Operación desconocida.'; end if;
 if coalesce(p->>'token','') !~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' then
  raise exception 'QR de AB Premier inválido.';
 end if;
 select * into card from ab_private.wallet_cards where token=(p->>'token')::uuid and not revoked;
 if not found then raise exception 'Tarjeta inválida o revocada.'; end if;
 -- Keep lock order consistent with the visit trigger, which updates the card after the client.
 select * into member from public.clients where id=card.client_id for update;
 perform 1 from ab_private.wallet_cards where client_id=member.id and token=card.token and not revoked for update;
 if not found then raise exception 'Tarjeta inválida o revocada.'; end if;
 if action='visit' then
  request_uuid:=(p->>'request_id')::uuid;
  selection:=jsonb_build_object('barber_id',p->>'barber_id','service_id',p->>'service_id');
  if request_uuid is not null then
   perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text||request_uuid::text,0));
   select * into saved from ab_private.wallet_visit_requests
    where employee_id=auth.uid() and request_id=request_uuid;
   if found then
    if saved.client_id<>member.id or saved.selection<>selection then
     raise exception 'La solicitud ya se usó con otro registro.';
    end if;
    return saved.result;
   end if;
  end if;
  result:=public.ab_api('visit',selection||jsonb_build_object('code',member.code));
  result:=result||jsonb_build_object('registered_at',now(),'next_prize',null,'remaining_to_next',0);
  select result||jsonb_build_object('next_prize',name,'remaining_to_next',cut-(result->>'visit_number')::int)
   into saved.result from ab_private.rewards where cut>(result->>'visit_number')::int order by cut limit 1;
  result:=coalesce(saved.result,result);
  if request_uuid is not null then
   insert into ab_private.wallet_visit_requests values(auth.uid(),request_uuid,member.id,selection,result);
  end if;
  return result;
 end if;
 result:=public.ab_api('lookup',jsonb_build_object('code',member.code));
 if action='lookup' then
  return jsonb_build_object('client',(result->'client')-'code'-'phone'-'birth_date'-'photo_path',
   'available',(select count(*) from public.courtesies where client_id=member.id and status='pending'));
 end if;
 return result;
end
$$;

create function ab_private.wallet_enqueue()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if tg_table_name='clients' then
  update ab_private.wallet_cards set revision=revision+1 where client_id=new.id;
 elsif tg_op='DELETE' then
  update ab_private.wallet_cards set revision=revision+1 where client_id=old.client_id;
 else
  update ab_private.wallet_cards set revision=revision+1 where client_id=new.client_id;
 end if;
 return null;
end
$$;

create trigger wallet_visit_changed after insert or delete on public.visits
 for each row execute function ab_private.wallet_enqueue();
create trigger wallet_courtesy_changed after insert or update or delete on public.courtesies
 for each row execute function ab_private.wallet_enqueue();
create trigger wallet_name_changed after update of full_name on public.clients
 for each row when (old.full_name is distinct from new.full_name) execute function ab_private.wallet_enqueue();

create function public.wallet_claim()
returns setof jsonb language sql security definer set search_path='' as $$
 with pending as (
  select client_id from ab_private.wallet_cards
  where revision>synced_revision and (lease_until is null or lease_until<now())
  order by lease_until nulls first,client_id limit 10 for update skip locked
 ), claimed as (
  update ab_private.wallet_cards c set lease_until=now()+interval '2 minutes'
  from pending p where c.client_id=p.client_id returning c.*
 )
 select ab_private.wallet_snapshot(c) from claimed c
$$;

create function public.wallet_synced(suffix uuid, synced bigint)
returns void language sql security definer set search_path='' as $$
 update ab_private.wallet_cards set synced_revision=greatest(synced_revision,synced),lease_until=null
 where object_suffix=suffix and synced<=revision
$$;

revoke all on function public.wallet_staff(text,jsonb),public.wallet_claim(),public.wallet_synced(uuid,bigint) from public,anon,authenticated;
grant execute on function public.wallet_staff(text,jsonb) to authenticated;
grant execute on function public.wallet_claim(),public.wallet_synced(uuid,bigint) to service_role;

commit;
