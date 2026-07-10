export function appointmentToSpeechText(item: any): string {
  const date = new Date(item.appointment_date);
  const dateStr = date.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const parts = [
    `Appointment with ${item.doctor_name || 'your provider'} at ${item.hospital || 'the clinic'}`,
    item.department ? `in the ${item.department} department` : '',
    `on ${dateStr} at ${timeStr}.`,
    item.title ? `Purpose: ${item.title}.` : '',
    item.details ? `Notes: ${item.details}.` : '',
  ];

  return parts.filter(Boolean).join(' ');
}

export function upcomingAppointmentsToSpeechText(items: any[]): string {
  if (items.length === 0) return 'You have no upcoming appointments.';

  const intro = `You have ${items.length} upcoming appointment${items.length > 1 ? 's' : ''}.`;
  const body = items.map((item, i) => `Number ${i + 1}. ${appointmentToSpeechText(item)}`).join(' ');

  return `${intro} ${body}`;
}
