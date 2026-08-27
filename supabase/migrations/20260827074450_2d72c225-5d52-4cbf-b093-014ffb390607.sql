CREATE TABLE public.kiosk_devices (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name text NOT NULL,
  location text,
  class text,
  section text,
  category text,
  is_active boolean NOT NULL DEFAULT true,
  token_hash text NOT NULL,
  token_prefix text,
  agent_version text,
  last_seen_at timestamp with time zone,
  last_ip text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX kiosk_devices_token_hash_key ON public.kiosk_devices (token_hash);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.kiosk_devices TO authenticated;
GRANT ALL ON public.kiosk_devices TO service_role;

ALTER TABLE public.kiosk_devices ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins manage kiosk devices"
ON public.kiosk_devices
FOR ALL
TO authenticated
USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'principal'))
WITH CHECK (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'principal'));

CREATE TRIGGER trg_kiosk_devices_updated_at
BEFORE UPDATE ON public.kiosk_devices
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.attendance_records ADD COLUMN IF NOT EXISTS kiosk_device_id uuid;