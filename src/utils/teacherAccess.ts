import { supabase } from '@/integrations/supabase/client';

const CLASS_ACCESS_PREFIX = 'class_access:';

const normalizeCategory = (value: string): string | null => {
  const raw = (value || '').trim();
  if (!raw) return null;
  const match = raw.match(/^(\d+)-([A-D])$/i);
  if (!match) return null;
  return `${match[1]}-${match[2].toUpperCase()}`;
};

export const parseClassSection = (category: string): { className: string; section: string } | null => {
  const normalized = normalizeCategory(category);
  if (!normalized) return null;
  const [className, section] = normalized.split('-');
  return { className, section };
};

const categoryFromPermissionKey = (key: string): string | null => {
  const raw = (key || '').trim();
  if (!raw) return null;
  if (raw.startsWith(CLASS_ACCESS_PREFIX)) {
    return normalizeCategory(raw.slice(CLASS_ACCESS_PREFIX.length));
  }
  if (/^\d+-[A-D]$/i.test(raw)) {
    return normalizeCategory(raw);
  }
  return null;
};

export const toClassAccessPermission = (category: string) => `${CLASS_ACCESS_PREFIX}${category}`;

export async function fetchTeacherCategories(userId: string): Promise<string[]> {
  const db = supabase as any;
  const categories = new Set<string>();

  const addFromRow = (row: any) => {
    const direct = normalizeCategory(String(row?.category || ''));
    if (direct) {
      categories.add(direct);
      return;
    }
    const cls = String(row?.class || '').trim();
    const sec = String(row?.section || '').trim();
    const combined = normalizeCategory(`${cls}-${sec}`);
    if (combined) categories.add(combined);
  };

  const permRows = await db
    .from('teacher_permissions')
    .select('category, class, section, teacher_id, user_id')
    .or(`teacher_id.eq.${userId},user_id.eq.${userId}`);

  if (!permRows.error && Array.isArray(permRows.data)) {
    permRows.data.forEach(addFromRow);
  }

  const classRows = await db
    .from('class_teachers')
    .select('category, class, section')
    .eq('teacher_id', userId);

  if (!classRows.error && Array.isArray(classRows.data)) {
    classRows.data.forEach(addFromRow);
  }

  return [...categories];
}


export async function hasTeacherAccess(userId: string): Promise<boolean> {
  const db = supabase as any;

  const categories = await fetchTeacherCategories(userId);
  if (categories.length > 0) return true;

  const classTeacherRows = await db
    .from('class_teachers')
    .select('id')
    .eq('teacher_id', userId)
    .limit(1);

  if (!classTeacherRows.error && Array.isArray(classTeacherRows.data) && classTeacherRows.data.length > 0) {
    return true;
  }

  const legacyTeacherRows = await db
    .from('attendance_records')
    .select('id')
    .eq('user_id', userId)
    .eq('category', 'Teacher')
    .eq('status', 'registered')
    .limit(1);

  return !legacyTeacherRows.error && Array.isArray(legacyTeacherRows.data) && legacyTeacherRows.data.length > 0;
}

export async function saveTeacherCategories(userId: string, categories: string[]): Promise<void> {
  const db = supabase as any;
  const normalized = [...new Set(categories.map(c => normalizeCategory(c)).filter(Boolean))] as string[];
  let wrote = false;
  let lastError: any = null;

  const newRows = normalized.map(category => ({
    teacher_id: userId,
    permission_key: toClassAccessPermission(category),
    is_enabled: true,
  }));

  const newDelete = await db.from('teacher_permissions').delete().eq('teacher_id', userId);
  if (!newDelete.error) {
    if (newRows.length > 0) {
      const newInsert = await db.from('teacher_permissions').insert(newRows);
      if (newInsert.error) {
        lastError = newInsert.error;
      } else {
        wrote = true;
      }
    } else {
      wrote = true;
    }
  } else {
    lastError = newDelete.error;
  }

  const legacyRows = normalized.map(category => ({
    user_id: userId,
    category,
    can_take_attendance: true,
    can_view_reports: true,
  }));

  const legacyDelete = await db.from('teacher_permissions').delete().eq('user_id', userId);
  if (!legacyDelete.error) {
    if (legacyRows.length > 0) {
      const legacyInsert = await db.from('teacher_permissions').insert(legacyRows);
      if (legacyInsert.error) {
        if (!wrote) lastError = legacyInsert.error;
      } else {
        wrote = true;
      }
    } else {
      wrote = true;
    }
  } else if (!wrote) {
    lastError = legacyDelete.error;
  }

  if (!wrote && lastError) throw lastError;
}
