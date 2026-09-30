// 试验地时段排期：同一地块上，已排定时段重叠的申请必须驳回。

const OVERLAP_OK = new Set(["已驳回"]); // 被驳回的申请不占用时段

function overlaps(a, b) {
  return a.start_date <= b.end_date && b.start_date <= a.end_date;
}

// 找出某条申请与已排定申请的冲突列表。
export function findSchedulingConflicts(pack) {
  const conflicts = [];
  for (const booking of pack.plot_bookings) {
    if (OVERLAP_OK.has(booking.status)) continue; // 被驳回的申请不参与占用
    for (const other of pack.plot_bookings) {
      if (other.id === booking.id || other.plot_id !== booking.plot_id) continue;
      if (OVERLAP_OK.has(other.status)) continue;
      if (overlaps(booking, other)) {
        conflicts.push({ booking_id: booking.id, conflicts_with: other.id, plot_id: booking.plot_id });
      }
    }
  }
  return conflicts;
}

// 平台受理一条新申请：与同地块任一已排定时段重叠则驳回并给出原因。
export function evaluateBooking(pack, candidate) {
  if (!candidate.start_date || !candidate.end_date || candidate.start_date > candidate.end_date) {
    return { status: "已驳回", rejected_reason: "排期日期不合法" };
  }
  const blocker = pack.plot_bookings.find(
    (b) =>
      b.id !== candidate.id &&
      b.plot_id === candidate.plot_id &&
      !OVERLAP_OK.has(b.status) &&
      overlaps(candidate, b),
  );
  if (blocker) {
    return {
      status: "已驳回",
      rejected_reason: `与已排定申请 ${blocker.id} 在地块 ${candidate.plot_id} 的时段 ${blocker.start_date}~${blocker.end_date} 重叠，平台排期校验驳回`,
    };
  }
  return { status: "已排定" };
}
