import React from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { Avatar, Surface, Text } from 'react-native-paper';
import { COLORS } from '../constants/theme';
import { useAuth } from '../context/AuthContext';

export default function ActiveProfileBadge() {
  const { user, activeDependent } = useAuth();
  const { t } = useTranslation();
  const displayUser = activeDependent || user;
  const isManaging = !!activeDependent;

  return (
    <View style={styles.container}>
      <Surface style={[styles.avatarWrapper, isManaging && styles.managingBorder]} elevation={0}>
        <Avatar.Image
          size={30}
          source={{ uri: `https://api.dicebear.com/7.x/initials/svg?seed=${displayUser?.username}&backgroundColor=${isManaging ? '26ba9d' : '6366f1'}` }}
        />
      </Surface>
      <View style={styles.textWrapper}>
        <Text style={styles.indicatorText}>{isManaging ? t('common.managing') : t('common.personal')}</Text>
        <Text style={styles.nameText} numberOfLines={1}>
          {displayUser?.full_name?.split(' ')[0]}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    marginRight: 16,
  },
  avatarWrapper: {
    borderRadius: 18,
    padding: 1,
  },
  managingBorder: {
    borderWidth: 2,
    borderColor: COLORS.accent,
  },
  textWrapper: {
    marginLeft: 8,
    maxWidth: 90,
  },
  indicatorText: {
    fontSize: 8,
    fontWeight: '900',
    color: COLORS.slate,
    letterSpacing: 0.5,
  },
  nameText: {
    fontSize: 13,
    fontWeight: '800',
    color: COLORS.ink,
    marginTop: -1,
  },
});
